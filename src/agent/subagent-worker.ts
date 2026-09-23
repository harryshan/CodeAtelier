/*
 * 在独立 Node Worker thread 中运行只读 subagent 模型循环，供主任务协调器按需启动。
 *
 * 1. 从 workerData 读取主任务指定的角色、目标和限额，构造独立历史与强制只读指令。
 * 2. 使用共用 runModelLoop 驱动轮次、模型重试、响应检查点；通过 parentPort 请求模型，
 *    模型密钥/网络只留在父进程，不直接导入文件系统或命令执行器。
 * 3. 验证全部工具调用只属于 subagentReadDefinitions，逐个请求父进程再次校验并保存结果，
 *    每一步先等待检查点回执；最后 postMessage 终态供父进程原子登记。
 *
 * Worker 身份不是安全边界。恶意依赖仍可直接使用 Node API；本模块只约束模型可调用的工具。
 */

import { parentPort, workerData } from "node:worker_threads";
import { runModelLoop } from "./model-loop.js";
import {
  parseSubagentReadCall,
  subagentReadDefinitions,
} from "./subagent-read-contract.js";
import type { ModelResult } from "../providers/model-provider.js";
import type {
  SubagentParentMessage,
  SubagentWorkerInput,
  SubagentWorkerRequest,
  SubagentWorkerMessage,
} from "./subagent-worker-protocol.js";

function requirePort() {
  if (!parentPort) {
    throw new Error("subagent 仅允许通过 Worker thread 启动。");
  }

  return parentPort;
}

const port = requirePort();

const task = workerData as SubagentWorkerInput;
const controller = new AbortController();
let nextId = 0;
const notes: string[] = [];
const pending = new Map<
  number,
  {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }
>();

port.on("message", (message: SubagentParentMessage) => {
  if (message.kind === "stop") {
    const reason = new Error("主任务已取消。");
    controller.abort(reason);
    for (const request of pending.values()) {
      request.reject(reason);
    }

    pending.clear();

    return;
  }

  if (message.kind === "message") {
    notes.push(message.text.slice(0, 2_000));

    return;
  }

  const request = pending.get(message.id);
  if (!request) {
    return;
  }

  pending.delete(message.id);
  if (message.ok) {
    request.resolve(message.result);
  } else {
    request.reject(new Error(message.error));
  }
});

function ask(operation: SubagentWorkerRequest["operation"], payload: unknown) {
  controller.signal.throwIfAborted();
  const id = ++nextId;

  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({
      kind: "request",
      id,
      operation,
      payload,
    } satisfies SubagentWorkerRequest);
  });
}

async function run() {
  const input: unknown[] = [
    {
      role: "user",
      content: `Role: ${task.role}\nObjective: ${task.objective}\nScope: ${task.scope.join(", ")}\nDeliverable: ${task.deliverable}`,
    },
  ];
  const instructions =
    "You are a read-only research subagent. You cannot write files, run commands, use Git or call other agents. Report findings, paths and evidence to the main agent; request any edits through your final report. Only call the provided read-only functions. Never assume previous file contents are current.";
  let finalReport = "";
  const outcome = await runModelLoop({
    maxSteps: Math.max(1, Math.min(12, task.maxSteps)),
    signal: controller.signal,
    prepareStep: async () => {
      if (notes.length) {
        input.push(
          ...notes.splice(0).map((content) => ({ role: "user", content })),
        );
        await ask("checkpoint", { status: "running", context: input });
      }

      if (JSON.stringify(input).length > 100_000) {
        throw new Error("subagent 上下文超过安全预算。");
      }
    },
    request: async (attempt) =>
      (await ask("model", {
        requestId: `model-${nextId + 1}`,
        attempt,
        input,
        instructions,
        tools: subagentReadDefinitions,
      })) as ModelResult,
    onRetry: () => {},
    prepareOverflow: async () => {
      throw new Error("subagent 上下文已满，不能安全自动重试。");
    },
    acceptResponse: async (response) => {
      input.push(...response.output);
      if (response.text) {
        finalReport = response.text.slice(0, 32_000);
      }

      await ask("checkpoint", { status: "running", context: input });
    },
    executeTools: async (calls) => {
      for (const call of calls) {
        let result: unknown;
        try {
          const parsed = parseSubagentReadCall(
            call.name,
            JSON.parse(call.arguments),
          );
          result = await ask("read", {
            requestId: call.call_id,
            name: call.name,
            arguments: parsed.arguments,
          });
        } catch (error) {
          result = {
            error:
              error instanceof Error
                ? error.message.slice(0, 250)
                : "只读工具失败。",
          };
        }

        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
        await ask("checkpoint", { status: "running", context: input });
      }

      return "executed";
    },
  });

  if (outcome !== "completed") {
    throw new Error("subagent 在限定轮次内未完成调查。");
  }

  port.postMessage({
    kind: "finish",
    status: "completed",
    report: finalReport,
    context: input,
  } satisfies SubagentWorkerMessage);
}

void run()
  .catch((error: unknown) => {
    port.postMessage({
      kind: "finish",
      status: controller.signal.aborted ? "cancelled" : "failed",
      report:
        error instanceof Error
          ? error.message.slice(0, 250)
          : "subagent 执行失败。",
      context: [],
    } satisfies SubagentWorkerMessage);
  })
  .finally(() => {
    port.close();
  });
