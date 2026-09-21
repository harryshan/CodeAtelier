/**
 * 验证任务上下文恢复可以通过 Runtime IPC session adapter 运行，而无需 Agent Runtime 打开宿主 SQLite。
 * 测试使用内存双向流和 Broker handler，覆盖缺失工具结果补齐、事件读取及保存回传。
 *
 * 1. Broker 返回含未完成 function_call 的上下文和已持久化 tool_result 事件。
 * 2. RuntimeSessionClient 实现 prepareTaskContext 所需窄接口，并把补齐后的上下文保存回 Broker。
 * 3. 断言 Runtime 得到已知结果和新用户输入；这只证明 adapter 行为，不证明 Windows transport 身份。
 */

import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { prepareTaskContext } from "../src/agent/context.js";
import { connectAgentRuntime } from "../src/sandbox/agent-runtime-connection.js";
import { RuntimeBrokerGateway } from "../src/sandbox/runtime-capability-core.js";
import { RuntimeIpcBrokerSession } from "../src/sandbox/runtime-ipc-broker-session.js";
import { RuntimeSessionClient } from "../src/sandbox/runtime-session-client.js";
import { TraceRecorder } from "../src/tracing/recorder.js";

it("restores and saves task context through the Broker session adapter", async () => {
  const runtimeToBroker = new PassThrough();
  const brokerToRuntime = new PassThrough();
  const identity = {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime" as const,
  };
  const nonce = "0123456789abcdef0123456789abcdef";
  const original = [
    {
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: "{}",
    },
  ];
  let saved: any[] | undefined;
  const gateway = new RuntimeBrokerGateway(
    {
      authorize: () => true,
      approveCommand: async () => ({ approved: true }),
      modelProvider: () => ({
        model: "unused",
        provider: { run: async () => ({ output: [], text: "" }) },
      }),
    },
    new TraceRecorder(),
  );
  new RuntimeIpcBrokerSession(
    { input: runtimeToBroker, output: brokerToRuntime },
    identity,
    nonce,
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
      appendSessionEvent: async () => undefined,
      saveContext: async (_runtime, input) => {
        saved = input;
      },
      readContext: async () => structuredClone(original),
      readEvents: async () => [
        {
          id: 1,
          sessionId: identity.sessionId,
          taskId: identity.taskId,
          type: "tool_result",
          data: { callId: "call-1", result: { text: "known" } },
          createdAt: new Date(0).toISOString(),
        },
      ],
      latestContextSnapshot: async () => undefined,
      readContextSnapshot: async () => undefined,
      compactContext: async () => undefined,
      runtimeCompleted: async () => undefined,
    },
  );
  const signal = AbortSignal.timeout(2_000);
  const peer = await connectAgentRuntime(
    { input: brokerToRuntime, output: runtimeToBroker },
    identity,
    nonce,
    signal,
  );
  const client = new RuntimeSessionClient(peer, signal);
  const input = await prepareTaskContext(
    client,
    identity.sessionId,
    "continue",
  );

  expect(input).toEqual([
    original[0],
    {
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ text: "known" }),
    },
    { role: "user", content: "continue" },
  ]);
  expect(saved).toEqual(input);
  peer.end();
});
