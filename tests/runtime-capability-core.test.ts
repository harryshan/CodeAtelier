/**
 * 验证 Sandbox Runtime→Broker capability core 的传输无关状态机。
 * 测试使用固定身份和模拟宿主适配器，不创建 Named Pipe、Windows token、进程或真实模型连接。
 *
 * 1. 命令审批签发绑定 execution instance、请求摘要和期限的一次性 grant，覆盖篡改、重放和错误身份。
 * 2. 未授权 Runtime 在进入审批或模型 handler 前拒绝，证明 transport 后仍有显式身份闸门。
 * 3. Broker 模型请求沿用 llm trace，并标记 Sandbox execution/kind/instance；prompt 和输出原文不进入 trace。
 *
 * 这些用例只证明协议状态机，不替代 supervisor/pipe 的 PID、token、Job、nonce 或 lease 联合身份证明。
 */

import { expect, it, vi } from "vitest";
import {
  RuntimeBrokerAuthorizationError,
  RuntimeBrokerGateway,
  type RuntimeBrokerHandlers,
  type RuntimeExecutionIdentity,
} from "../src/sandbox/runtime-capability-core.js";
import { TraceRecorder } from "../src/tracing/recorder.js";

const identity: RuntimeExecutionIdentity = {
  sessionId: "session-1",
  taskId: "task-1",
  executionInstanceId: "runtime-1",
  kind: "agent-runtime",
};

function handlers(
  overrides: Partial<RuntimeBrokerHandlers> = {},
): RuntimeBrokerHandlers {
  return {
    authorize: () => true,
    approveCommand: async () => ({ approved: true }),
    modelProvider: () => ({
      model: "test-model",
      provider: {
        async run(_input, _instructions, _tools, _signal, onDelta) {
          onDelta("delta-secret");

          return { output: [], text: "model-secret" };
        },
      },
    }),
    ...overrides,
  };
}

it("issues and consumes a command grant once for the exact runtime request", async () => {
  let now = 1_000;
  const traces = new TraceRecorder();
  traces.startTask(identity.taskId, identity.sessionId);
  const gateway = new RuntimeBrokerGateway(
    handlers(),
    traces,
    undefined,
    () => now,
  );
  const request = {
    requestId: "request-1",
    command: "pnpm test",
    cwd: "G:\\workspace",
    timeoutMs: 10_000,
  };
  const response = await gateway.requestCommandApproval(
    identity,
    request,
    new AbortController().signal,
  );

  expect(response).toMatchObject({
    decision: "approved",
    requestId: request.requestId,
    requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    grantId: expect.any(String),
  });
  expect(
    gateway.consumeCommandGrant(identity, response.grantId!, request),
  ).toBe(true);
  expect(
    gateway.consumeCommandGrant(identity, response.grantId!, request),
  ).toBe(false);

  const second = await gateway.requestCommandApproval(
    identity,
    { ...request, requestId: "request-2" },
    new AbortController().signal,
  );
  now = second.expiresAt! + 1;
  expect(
    gateway.consumeCommandGrant(identity, second.grantId!, {
      ...request,
      requestId: "request-2",
    }),
  ).toBe(false);
});

it("rejects an unauthenticated runtime before invoking host handlers", async () => {
  const approveCommand = vi.fn(async () => ({ approved: true }));
  const modelProvider = vi.fn();
  const gateway = new RuntimeBrokerGateway(
    handlers({ authorize: () => false, approveCommand, modelProvider }),
    new TraceRecorder(),
  );

  await expect(
    gateway.requestCommandApproval(
      identity,
      {
        requestId: "request-1",
        command: "pnpm test",
        cwd: "G:\\workspace",
        timeoutMs: 10_000,
      },
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(RuntimeBrokerAuthorizationError);
  expect(approveCommand).not.toHaveBeenCalled();
  expect(modelProvider).not.toHaveBeenCalled();
});

it("traces brokered sandbox model requests without prompt or output text", async () => {
  const traces = new TraceRecorder();
  traces.startTask(identity.taskId, identity.sessionId);
  const gateway = new RuntimeBrokerGateway(handlers(), traces);
  const deltas: string[] = [];

  const result = await gateway.requestModel(
    identity,
    {
      requestId: "model-request-1",
      purpose: "task",
      input: [{ role: "user", content: "prompt-secret" }],
      instructions: "instruction-secret",
      tools: [],
      maxOutputTokens: 100,
    },
    new AbortController().signal,
    (delta) => deltas.push(delta),
  );
  traces.finishTask(identity.taskId, "ok");
  const exported = traces.exportTask(identity.taskId);
  const model = exported?.traceEvents.find(
    (event: { name: string; ph: string }) =>
      event.name === "llm.request" && event.ph === "B",
  );

  expect(result.text).toBe("model-secret");
  expect(deltas).toEqual(["delta-secret"]);
  expect(model.args).toMatchObject({
    brokered: true,
    executionMode: "windows-sandbox-user",
    executionInstanceId: "runtime-1",
    runtimeKind: "agent-runtime",
    inputItems: 1,
  });
  expect(JSON.stringify(exported)).not.toContain("prompt-secret");
  expect(JSON.stringify(exported)).not.toContain("instruction-secret");
  expect(JSON.stringify(exported)).not.toContain("model-secret");
  expect(JSON.stringify(exported)).not.toContain("delta-secret");
});
