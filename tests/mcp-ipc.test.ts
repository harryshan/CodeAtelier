/**
 * 验证 MCP 的 Runtime/Broker 两阶段授权，不使用真实网络或 MCP 服务。
 *
 * 1. 内存 duplex 和正式握手绑定 task/session/instance，handlers 只接收权威身份。
 * 2. prepare 不执行 MCP；execute 只消费对应调用的一次性授权，跨调用冒用和重复消费均拒绝。
 * 3. strict request schema 拒绝 URL/命令等宿主配置字段和未知操作，旧协议版本不能握手。
 */
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { RuntimeIpcBrokerSession } from "../src/sandbox/runtime-ipc-broker-session.js";
import { RuntimeBrokerGateway } from "../src/sandbox/runtime-capability-core.js";
import { connectAgentRuntime } from "../src/sandbox/agent-runtime-connection.js";
import { runtimeIpcMessageSchema } from "../src/sandbox/runtime-ipc-protocol.js";
import { TraceRecorder } from "../src/tracing/recorder.js";

it("binds MCP authorizations to one authenticated connection and tool call", async () => {
  const toBroker = new PassThrough();
  const toRuntime = new PassThrough();
  const identity = {
    sessionId: "session",
    taskId: "task",
    executionInstanceId: "runtime",
    kind: "agent-runtime" as const,
  };
  const nonce = "0123456789abcdef0123456789abcdef";
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
  let executions = 0;
  new RuntimeIpcBrokerSession(
    { input: toBroker, output: toRuntime },
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
      prepareCapabilityCommand: async () => {
        throw new Error("unused");
      },
      prepareMcp: async (actual, request, callId) => {
        expect(actual).toEqual(identity);
        expect(request).toEqual({ action: "list_servers" });
        expect(callId).toBe("mcp-call");

        return async () => {
          executions += 1;

          return {
            execution: { kind: "broker-mcp", mode: "host-process" },
            data: [],
          };
        };
      },
      applyMemory: async () => ({}),
      appendSessionEvent: async () => undefined,
      saveContext: async () => undefined,
      readContext: async () => [],
      readEvents: async () => [],
      latestContextSnapshot: async () => undefined,
      readContextSnapshot: async () => undefined,
      compactContext: async () => undefined,
      runtimeCompleted: async () => undefined,
    },
  );
  const peer = await connectAgentRuntime(
    { input: toRuntime, output: toBroker },
    identity,
    nonce,
    AbortSignal.timeout(1000),
  );
  const signal = AbortSignal.timeout(1000);
  try {
    const { authorizationId } = (await peer.request(
      "prepare_mcp",
      { toolCallId: "mcp-call", request: { action: "list_servers" } },
      signal,
    )) as { authorizationId: string };
    expect(executions).toBe(0);
    await expect(
      peer.request(
        "execute_mcp",
        { authorizationId, toolCallId: "wrong-call" },
        signal,
      ),
    ).rejects.toThrow("不属于");
    expect(executions).toBe(0);
    expect(
      await peer.request(
        "execute_mcp",
        { authorizationId, toolCallId: "mcp-call" },
        signal,
      ),
    ).toMatchObject({ data: [] });
    await expect(
      peer.request(
        "execute_mcp",
        { authorizationId, toolCallId: "mcp-call" },
        signal,
      ),
    ).rejects.toThrow("已消费");
    expect(executions).toBe(1);
  } finally {
    peer.end();
  }
});

it("rejects MCP connection configuration in Runtime tool requests", () => {
  const request = {
    type: "request",
    requestId: "request",
    operation: "prepare_mcp",
    body: {
      toolCallId: "call",
      request: { action: "list_tools", server: "configured", cursor: null },
    },
  };
  expect(runtimeIpcMessageSchema.safeParse(request).success).toBe(true);
  expect(
    runtimeIpcMessageSchema.safeParse({
      ...request,
      body: { ...request.body, url: "https://example.com" },
    }).success,
  ).toBe(false);
  expect(
    runtimeIpcMessageSchema.safeParse({
      ...request,
      body: {
        ...request.body,
        request: { ...request.body.request, command: "node" },
      },
    }).success,
  ).toBe(false);
  expect(
    runtimeIpcMessageSchema.safeParse({
      type: "hello",
      protocolVersion: 4,
      nonce: "0123456789abcdef0123456789abcdef",
    }).success,
  ).toBe(false);
});
