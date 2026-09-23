/*
 * 用真实 Node Worker thread 和假父进程 RPC 驱动 subagent 独立 loop，不访问真实模型或文件。
 *
 * 1. 检查带版本与任务归属的模型/只读工具、历史检查点与最终报告均按递增序号交互。
 * 2. 模型试图调用写入工具时必须返回拒绝结果；父进程身份错误会使子循环失败，取消中断等待父进程的 RPC。
 *
 * 此测试仅证明 Worker loop 和消息协议，实际路径校验由 subagent-readonly.test.ts 验证。
 */

import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { SUBAGENT_WORKER_PROTOCOL_VERSION } from "../src/agent/subagent-worker-protocol.js";
import type {
  SubagentWorkerMessage,
  SubagentParentMessage,
} from "../src/agent/subagent-worker-protocol.js";

function source() {
  return new URL("../src/agent/subagent-worker.ts", import.meta.url);
}

async function exercise(tool: string) {
  const worker = new Worker(source(), {
    execArgv: ["--import", "tsx"],
    workerData: {
      id: "review",
      taskId: "test-task",
      role: "reviewer",
      objective: "inspect",
      scope: ["src"],
      deliverable: "evidence",
      maxSteps: 3,
    },
  });
  const operations: string[] = [];
  let modelCalls = 0;
  let readCalls = 0;
  let parentSequence = 0;
  const childSequences: number[] = [];
  const finish = new Promise<
    Extract<SubagentWorkerMessage, { kind: "finish" }>
  >((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited: ${code}`));
      }
    });
    worker.on("message", (message: SubagentWorkerMessage) => {
      expect(message).toMatchObject({
        version: SUBAGENT_WORKER_PROTOCOL_VERSION,
        taskId: "test-task",
        subagentId: "review",
      });
      childSequences.push(message.sequence);
      if (message.kind === "finish") {
        resolve(message);

        return;
      }

      operations.push(message.operation);
      let result: unknown;
      if (message.operation === "model") {
        modelCalls++;
        result =
          modelCalls === 1
            ? {
                output: [
                  {
                    type: "function_call",
                    call_id: "call-a",
                    name: tool,
                    arguments: JSON.stringify({
                      execution: { id: "read", dependsOn: [] },
                      arguments: {
                        path: "src/example.ts",
                        startLine: 1,
                        endLine: 1,
                      },
                    }),
                  },
                ],
                text: "",
              }
            : { output: [], text: "Evidence: source line 1" };
      } else if (message.operation === "read") {
        readCalls++;
        result = { text: "1: found" };
      } else {
        result = { ok: true };
      }

      worker.postMessage({
        version: SUBAGENT_WORKER_PROTOCOL_VERSION,
        taskId: "test-task",
        subagentId: "review",
        sequence: ++parentSequence,
        kind: "response",
        id: message.id,
        ok: true,
        result,
      } satisfies SubagentParentMessage);
    });
  });

  const output = await finish;
  await worker.terminate();

  return { output, operations, readCalls, childSequences };
}

it("runs its own model loop and only asks parent for read-only tools", async () => {
  const result = await exercise("read_file");
  expect(result.output).toMatchObject({
    kind: "finish",
    status: "completed",
    report: "Evidence: source line 1",
  });
  expect(result.operations).toEqual([
    "model",
    "checkpoint",
    "read",
    "checkpoint",
    "model",
    "checkpoint",
  ]);
  expect(result.readCalls).toBe(1);
  expect(result.childSequences).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

it("stops while waiting for a model response without replaying the request", async () => {
  const worker = new Worker(source(), {
    execArgv: ["--import", "tsx"],
    workerData: {
      id: "review",
      taskId: "test-task",
      role: "reviewer",
      objective: "inspect",
      scope: ["src"],
      deliverable: "evidence",
      maxSteps: 3,
    },
  });
  let requests = 0;
  const finished = new Promise<SubagentWorkerMessage>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message: SubagentWorkerMessage) => {
      if (message.kind === "request") {
        requests++;
        worker.postMessage({
          version: SUBAGENT_WORKER_PROTOCOL_VERSION,
          taskId: "test-task",
          subagentId: "review",
          sequence: 1,
          kind: "stop",
        } satisfies SubagentParentMessage);
      } else {
        resolve(message);
      }
    });
  });

  expect(await finished).toMatchObject({ kind: "finish", status: "cancelled" });
  expect(requests).toBe(1);
  await worker.terminate();
});

it("rejects a parent response addressed to another task before accepting its model result", async () => {
  const worker = new Worker(source(), {
    execArgv: ["--import", "tsx"],
    workerData: {
      taskId: "test-task",
      id: "review",
      role: "reviewer",
      objective: "inspect",
      scope: ["src"],
      deliverable: "evidence",
      maxSteps: 3,
    },
  });

  try {
    const finished = new Promise<SubagentWorkerMessage>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message: SubagentWorkerMessage) => {
        if (message.kind === "request") {
          worker.postMessage({
            version: SUBAGENT_WORKER_PROTOCOL_VERSION,
            taskId: "another-task",
            subagentId: "review",
            sequence: 1,
            kind: "response",
            id: message.id,
            ok: true,
            result: { output: [], text: "forged result" },
          } satisfies SubagentParentMessage);
        } else {
          resolve(message);
        }
      });
    });

    await expect(finished).resolves.toMatchObject({
      kind: "finish",
      status: "failed",
      report: expect.stringContaining("归属"),
    });
  } finally {
    await worker.terminate();
  }
});

it("reports a denied write request to the model without issuing a parent read", async () => {
  const result = await exercise("edit_files");
  expect(result.output.status).toBe("completed");
  expect(result.readCalls).toBe(0);
  expect(result.operations).toEqual([
    "model",
    "checkpoint",
    "checkpoint",
    "model",
    "checkpoint",
  ]);
});
