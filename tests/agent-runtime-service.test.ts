/**
 * 验证完整模型/工具轮次在独立 Agent Runtime 子进程中运行，而模型 provider、session 和完成账本留在 Broker 测试进程。
 * 此测试跨真实 Node 进程执行 read_file，并证明第二轮模型输入包含子进程工具结果；stdio harness 不替代 Windows transport 身份验收。
 *
 * 1. Broker 先返回一次可重试错误，再返回无效 DAG；Runtime 有界重试并把无副作用错误保存给下一轮修正。
 * 2. Broker 随后返回 read_file function_call，Agent Runtime 在自己的进程内执行 ToolRunner；最终模型轮次观察到文件结果。
 * 3. 含 push 的工具批次在执行任何节点前要求 push 是唯一调用；扩展权限请求保留普通 DAG 并行语义。
 * 4. Runtime 主动报告 completed，Broker 收到后关闭通道并确认子进程干净退出。
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { RuntimeBrokerGateway } from "../src/sandbox/runtime-capability-core.js";
import { RuntimeIpcBrokerSession } from "../src/sandbox/runtime-ipc-broker-session.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { ModelError } from "../src/providers/model-error.js";
import { temp } from "./fixtures/helpers.js";
import { buildModelToolGraph } from "../src/tools/model-tool-batch.js";

it("requires git push to be the only tool in its batch", () => {
  const push = {
    type: "function_call",
    call_id: "push-call",
    name: "git",
    arguments: JSON.stringify({
      execution: { id: "push", dependsOn: [] },
      arguments: { request: { action: "push" } },
    }),
  };
  const read = {
    type: "function_call",
    call_id: "read-call",
    name: "read_file",
    arguments: JSON.stringify({
      execution: { id: "read", dependsOn: [] },
      arguments: { path: "sample.txt", startLine: 1, endLine: 1 },
    }),
  };

  expect(
    buildModelToolGraph([push], { exclusivePush: true }).nodes,
  ).toHaveLength(1);
  expect(() =>
    buildModelToolGraph([push, read], { exclusivePush: true }),
  ).toThrow("Git push 必须是当前工具批次的唯一调用");
});

it("allows a capability command beside an independent tool", () => {
  const capability = {
    type: "function_call",
    call_id: "capability-call",
    name: "run_with_permissions",
    arguments: JSON.stringify({
      execution: { id: "capability", dependsOn: [] },
      arguments: {
        command: "tool --version",
        reason: "请求 Broker 宿主权限读取外部工具目录。",
      },
    }),
  };
  const read = {
    type: "function_call",
    call_id: "read-call",
    name: "read_file",
    arguments: JSON.stringify({
      execution: { id: "read", dependsOn: [] },
      arguments: { path: "sample.txt", startLine: 1, endLine: 1 },
    }),
  };

  expect(
    buildModelToolGraph([capability, read], { exclusivePush: true }).nodes,
  ).toHaveLength(2);
});

it("runs the model and tool loop in an independent Agent Runtime process", async () => {
  const workspace = await temp();
  await writeFile(path.join(workspace, "sample.txt"), "runtime-owned\n");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("tests/fixtures/agent-runtime-service-child.ts"),
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEATELIER_TEST_RUNTIME_DESCRIPTOR: JSON.stringify({
          identity: {
            sessionId: "session-1",
            taskId: "task-1",
            executionInstanceId: "runtime-1",
            kind: "agent-runtime",
          },
          nonce: "0123456789abcdef0123456789abcdef",
        }),
      },
    },
  );
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const identity = {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime" as const,
  };
  let context: any[] = [];
  const events: Array<{ type: string; data: unknown }> = [];
  let modelCalls = 0;
  let completed = false;
  const traces = new TraceRecorder();
  traces.startTask(identity.taskId, identity.sessionId);
  const gateway = new RuntimeBrokerGateway(
    {
      authorize: (candidate) => candidate === identity,
      approveCommand: async () => ({ approved: true }),
      modelProvider: () => ({
        model: "fixture-model",
        provider: {
          async getCapabilities() {
            return {
              tokenizer: "o200k_base",
              limits: {
                max_context_window_tokens: 64_000,
                max_output_tokens: 1_024,
              },
            };
          },
          async run(input) {
            modelCalls += 1;
            if (modelCalls === 1) {
              throw new ModelError(
                "temporary fixture failure",
                true,
                "http_503",
                503,
              );
            }

            if (modelCalls === 2) {
              return {
                text: "",
                output: [
                  {
                    type: "function_call",
                    call_id: "invalid-call",
                    name: "read_file",
                    arguments: "{",
                  },
                ],
              };
            }

            if (modelCalls === 3) {
              expect(JSON.stringify(input)).toContain("工具调用图无效");

              return {
                text: "",
                output: [
                  {
                    type: "function_call",
                    call_id: "call-1",
                    name: "read_file",
                    arguments: JSON.stringify({
                      execution: { id: "read", dependsOn: [] },
                      arguments: {
                        path: "sample.txt",
                        startLine: 1,
                        endLine: 10,
                      },
                    }),
                  },
                ],
              };
            }

            expect(JSON.stringify(input)).toContain("runtime-owned");

            return { text: "完成", output: [] };
          },
        },
      }),
    },
    traces,
  );
  const broker = new RuntimeIpcBrokerSession(
    { input: child.stdout, output: child.stdin },
    identity,
    "0123456789abcdef0123456789abcdef",
    gateway,
    {
      requestApproval: async () => ({ approved: true }),
      executeGitPush: async () => ({
        output: "",
        exitCode: 0,
        truncated: false,
      }),
      prepareCapabilityCommand: async () => async () => ({
        executionInstanceId: "capability-test",
        output: "",
        exitCode: 0,
        truncated: false,
      }),
      applyMemory: async () => ({ applied: true }),
      appendSessionEvent: async (_runtime, type, data) => {
        events.push({ type, data });
      },
      saveContext: async (_runtime, input) => {
        context = structuredClone(input);
      },
      readContext: async () => structuredClone(context),
      readEvents: async () => [],
      latestContextSnapshot: async () => undefined,
      readContextSnapshot: async () => undefined,
      compactContext: async () => undefined,
      runtimeCompleted: async (_runtime, result) => {
        completed = result.status === "completed";
      },
    },
  );
  let result: unknown;
  try {
    result = await broker.startTask(
      {
        workspace,
        prompt: "读取 sample.txt",
        settings: {
          model: "fixture-model",
          maxSteps: 5,
          commandTimeoutMs: 10_000,
          maxOutputTokens: 1_024,
          maxContextTokens: 240_000,
          contextChars: 64_000,
          outputChars: 10_000,
        },
      },
      AbortSignal.timeout(15_000),
    );
  } catch (error) {
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; child stderr=${Buffer.concat(errors).toString("utf8")}`,
    );
  }

  broker.peer.end();
  const exit = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );

  expect(result).toEqual({ status: "completed" });
  expect(completed).toBe(true);
  expect(modelCalls).toBe(4);
  expect(context.some((item) => item.type === "function_call_output")).toBe(
    true,
  );
  expect(events.some((event) => event.type === "assistant")).toBe(true);
  expect(
    events.find((event) => event.type === "context_budget")?.data,
  ).toMatchObject({
    effectiveWindowTokens: 240_000,
  });
  expect(events.some((event) => event.type === "notice")).toBe(true);
  expect(Buffer.concat(errors).toString("utf8")).toBe("");
  expect(exit).toBe(0);
});
