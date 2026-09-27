/**
 * 验证 Agent Runtime IPC 的有界 framing、请求关联、取消和真实子进程 stdio 路由。
 * 内存流用例覆盖协议错误，独立 Node fixture 覆盖 model request/delta/response 跨进程，但不冒充 Windows Named Pipe 身份验收。
 *
 * 1. 双向 PassThrough peer 完成请求并拒绝未知响应、畸形 JSON 和超限半帧。
 * 2. RuntimeGitPushClient 只发送调用 ID；RuntimeGitClient 发送受限 action 并保留 add/commit/diff 结果形状；RuntimeCapabilityClient 先准备审批、再用连接内一次性授权执行，且授权不可重放。
 * 3. AbortSignal 发送 request_cancel，中止远端同 requestId handler；竞态迟到响应不会破坏后续请求。
 * 4. Runtime trace 与 session event 只接受固定类型；子消息/取消 span 不携带正文，Runtime 不能伪造 Broker execution/sandbox/终态事件。
 * 5. 子进程经继承 stdio 请求模型，Broker test adapter 流式回传 delta 和最终结果，进程正常退出。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  RuntimeIpcError,
  RuntimeIpcPeer,
} from "../src/sandbox/runtime-ipc-peer.js";
import { RuntimeIpcBrokerSession } from "../src/sandbox/runtime-ipc-broker-session.js";
import { RuntimeBrokerGateway } from "../src/sandbox/runtime-capability-core.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { connectAgentRuntime } from "../src/sandbox/agent-runtime-connection.js";
import {
  RuntimeCapabilityClient,
  RuntimeGitPushClient,
  RuntimeGitClient,
} from "../src/sandbox/runtime-tool-adapters.js";
import { runtimeIpcMessageSchema } from "../src/sandbox/runtime-ipc-protocol.js";

function peers() {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  const right = new RuntimeIpcPeer({
    input: leftToRight,
    output: rightToLeft,
    handleRequest: async (request) => ({ operation: request.operation }),
  });
  const left = new RuntimeIpcPeer({ input: rightToLeft, output: leftToRight });

  return { left, right, leftToRight, rightToLeft };
}

it("routes a bounded request and response", async () => {
  const { left } = peers();
  const result = await left.request(
    "session_read_context",
    {},
    new AbortController().signal,
  );
  expect(result).toEqual({ operation: "session_read_context" });
});

it("sends only the push tool call ID to the broker", async () => {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  let received: unknown;
  const right = new RuntimeIpcPeer({
    input: leftToRight,
    output: rightToLeft,
    handleRequest: async (request) => {
      received = request;

      return { output: "pushed", exitCode: 0, truncated: false };
    },
  });
  const left = new RuntimeIpcPeer({ input: rightToLeft, output: leftToRight });
  await expect(
    new RuntimeGitPushClient(left).execute(
      "push-call",
      new AbortController().signal,
    ),
  ).resolves.toEqual({ output: "pushed", exitCode: 0, truncated: false });
  expect(received).toMatchObject({
    operation: "git_push",
    body: { toolCallId: "push-call" },
  });
  right.end();
  left.end();
});

it("sends only a validated Git action and task call ID to Broker", async () => {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  let received: unknown;
  const right = new RuntimeIpcPeer({
    input: leftToRight,
    output: rightToLeft,
    handleRequest: async (request) => {
      received = request;

      return { output: "branch", exitCode: 0, truncated: false };
    },
  });
  const left = new RuntimeIpcPeer({ input: rightToLeft, output: leftToRight });
  await expect(
    new RuntimeGitClient(left).execute(
      { action: "status" },
      "status-call",
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ output: "branch", exitCode: 0 });
  expect(received).toMatchObject({
    operation: "git_execute",
    body: { toolCallId: "status-call", request: { action: "status" } },
  });
  await expect(
    left.request(
      "git_execute",
      {
        toolCallId: "bad-call",
        request: { action: "status", args: ["--exec"] },
      },
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(RuntimeIpcError);
  right.end();
  left.end();
});

it("keeps action-specific Broker Git results across IPC", async () => {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  const processResult = { output: "ok", exitCode: 0, truncated: false };
  const right = new RuntimeIpcPeer({
    input: leftToRight,
    output: rightToLeft,
    handleRequest: async (request) => {
      if (request.operation !== "git_execute") {
        throw new Error("unexpected operation");
      }

      switch (request.body.request.action) {
        case "add":
          return { paths: ["change.txt"], add: processResult };
        case "commit":
          return {
            paths: ["change.txt"],
            stage: processResult,
            commit: processResult,
          };
        case "diff":
          return { ...processResult, staged: false, paths: ["change.txt"] };
        default:
          throw new Error("unexpected action");
      }
    },
  });
  const left = new RuntimeIpcPeer({ input: rightToLeft, output: leftToRight });
  const client = new RuntimeGitClient(left);
  const signal = new AbortController().signal;

  try {
    await expect(
      client.execute({ action: "add", paths: ["change.txt"] }, "add", signal),
    ).resolves.toEqual({ paths: ["change.txt"], add: processResult });
    await expect(
      client.execute(
        { action: "commit", paths: ["change.txt"], message: "Record change" },
        "commit",
        signal,
      ),
    ).resolves.toEqual({
      paths: ["change.txt"],
      stage: processResult,
      commit: processResult,
    });
    await expect(
      client.execute(
        {
          action: "diff",
          staged: false,
          paths: ["change.txt"],
          contextLines: 3,
        },
        "diff",
        signal,
      ),
    ).resolves.toEqual({
      ...processResult,
      staged: false,
      paths: ["change.txt"],
    });
  } finally {
    right.end();
    left.end();
  }
});

it("sends a bounded capability command with its reason and tool call", async () => {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  const received: unknown[] = [];
  const right = new RuntimeIpcPeer({
    input: leftToRight,
    output: rightToLeft,
    handleRequest: async (request) => {
      received.push(request);

      return request.operation === "prepare_run_with_permissions"
        ? { authorizationId: "authorization-1" }
        : {
            executionInstanceId: "capability-1",
            output: "done",
            exitCode: 0,
            truncated: false,
          };
    },
  });
  const left = new RuntimeIpcPeer({ input: rightToLeft, output: leftToRight });
  const request = {
    command: "node external-task.js",
    reason: "需要 Broker 宿主权限处理工作区外的对象。",
  };

  await expect(
    (
      await new RuntimeCapabilityClient(left).prepare(
        request,
        "capability-call",
        new AbortController().signal,
      )
    )(),
  ).resolves.toMatchObject({
    executionInstanceId: "capability-1",
    output: "done",
  });
  expect(received).toEqual([
    expect.objectContaining({
      operation: "prepare_run_with_permissions",
      body: { toolCallId: "capability-call", request },
    }),
    expect.objectContaining({
      operation: "run_with_permissions",
      body: {
        toolCallId: "capability-call",
        authorizationId: "authorization-1",
      },
    }),
  ]);
  right.end();
  left.end();
});

it("keeps an approved capability command inactive until its one-time authorization is consumed", async () => {
  const runtimeToBroker = new PassThrough();
  const brokerToRuntime = new PassThrough();
  const identity = {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime" as const,
  };
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
    { input: runtimeToBroker, output: brokerToRuntime },
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
      prepareCapabilityCommand: async () => async () => {
        executions++;

        return {
          executionInstanceId: "capability-test",
          output: "executed",
          exitCode: 0,
          truncated: false,
        };
      },
      applyMemory: async () => ({ applied: true }),
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
    { input: brokerToRuntime, output: runtimeToBroker },
    identity,
    "0123456789abcdef0123456789abcdef",
    AbortSignal.timeout(1_000),
  );
  const execute = await new RuntimeCapabilityClient(peer).prepare(
    {
      command: "external-tool --version",
      reason: "验证两阶段授权。",
    },
    "capability-call",
    AbortSignal.timeout(1_000),
  );

  expect(executions).toBe(0);
  await expect(execute()).resolves.toMatchObject({ output: "executed" });
  expect(executions).toBe(1);
  await expect(execute()).rejects.toBeInstanceOf(RuntimeIpcError);
  expect(executions).toBe(1);
  peer.end();
});

it("fails the channel on malformed input", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new RuntimeIpcPeer({ input, output });
  input.write("not-json\n");
  await expect(
    peer.request("session_read_context", {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(RuntimeIpcError);
});

it("accepts only bounded context trace events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: unknown[] = [];
  const peer = new RuntimeIpcPeer({
    input,
    output,
    onEvent: (event) => events.push(event),
  });
  input.write(
    `${JSON.stringify({
      type: "event",
      event: "trace_span_start",
      spanId: "span-1",
      name: "context.prepare",
      timestampUs: Math.round(Date.now() * 1_000),
      attributes: { step: 1, inputItems: 3 },
    })}\n`,
  );
  await expect.poll(() => events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "trace_span_start",
    name: "context.prepare",
  });

  for (const name of [
    "read_file.worker.response",
    "subagent.message",
    "subagent.cancel",
  ]) {
    const frame = {
      type: "event",
      event: "trace_span_start",
      spanId: "span-subagent",
      name,
      timestampUs: Math.round(Date.now() * 1_000),
      attributes: name.startsWith("read_file.")
        ? { callId: "reader", bytes: 42 }
        : { subagentId: "reader" },
    };
    expect(runtimeIpcMessageSchema.safeParse(frame).success).toBe(true);
    if (name.startsWith("read_file.")) {
      expect(
        runtimeIpcMessageSchema.safeParse({
          ...frame,
          attributes: { bytes: 42 },
        }).success,
      ).toBe(false);
      expect(
        runtimeIpcMessageSchema.safeParse({
          ...frame,
          attributes: { callId: "reader", bytes: 2 * 1024 * 1024 + 1 },
        }).success,
      ).toBe(false);
    }

    expect(
      runtimeIpcMessageSchema.safeParse({
        ...frame,
        attributes: { callId: "reader", text: "secret" },
      }).success,
    ).toBe(false);
  }

  expect(
    runtimeIpcMessageSchema.safeParse({
      type: "event",
      event: "trace_span_start",
      spanId: "pool-close",
      timestampUs: Math.round(Date.now() * 1_000),
      name: "read_file.pool.close",
      attributes: {},
    }).success,
  ).toBe(true);
  expect(
    runtimeIpcMessageSchema.safeParse({
      type: "event",
      event: "trace_span_start",
      spanId: "missing-time",
      name: "context.prepare",
      attributes: {},
    }).success,
  ).toBe(false);
  expect(
    runtimeIpcMessageSchema.safeParse({
      type: "event",
      event: "trace_span_start",
      spanId: "execution",
      timestampUs: Math.round(Date.now() * 1_000),
      name: "tool.execute",
      attributes: { callId: "reader", slot: 0 },
    }).success,
  ).toBe(true);
  expect(
    runtimeIpcMessageSchema.safeParse({
      type: "event",
      event: "trace_span_start",
      spanId: "no-slot",
      timestampUs: Math.round(Date.now() * 1_000),
      name: "tool.execute",
      attributes: { callId: "reader" },
    }).success,
  ).toBe(false);

  input.write(
    `${JSON.stringify({
      type: "event",
      event: "trace_span_start",
      spanId: "span-2",
      name: "arbitrary.runtime.log",
      attributes: { secret: "not allowed" },
    })}\n`,
  );
  await expect(
    peer.request("session_read_context", {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(RuntimeIpcError);
});

it("does not let the runtime forge broker-owned session events", () => {
  const message = {
    type: "request",
    requestId: "request-1",
    operation: "session_append_event",
    body: {
      eventType: "execution_instance",
      data: { sandboxApplied: true, state: "completed" },
    },
  };

  expect(runtimeIpcMessageSchema.safeParse(message).success).toBe(false);
  expect(
    runtimeIpcMessageSchema.safeParse({
      ...message,
      body: { eventType: "tool_result", data: { callId: "call-1" } },
    }).success,
  ).toBe(true);
});

it("closes the channel when an event observer rejects the message", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new RuntimeIpcPeer({
    input,
    output,
    onEvent: () => {
      throw new Error("semantic trace failure");
    },
  });
  input.write(
    `${JSON.stringify({
      type: "event",
      event: "trace_span_start",
      spanId: "span-1",
      timestampUs: Math.round(Date.now() * 1_000),
      name: "context.prepare",
      attributes: { step: 1 },
    })}\n`,
  );

  await expect(
    peer.request("session_read_context", {}, new AbortController().signal),
  ).rejects.toThrow("Runtime IPC 消息分发失败");
});

it("cancels a pending request", async () => {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  let resolveRemoteAbort!: () => void;
  const remoteAborted = new Promise<void>((resolve) => {
    resolveRemoteAbort = resolve;
  });
  const right = new RuntimeIpcPeer({
    input: leftToRight,
    output: rightToLeft,
    handleRequest: async (request, signal) => {
      if (request.operation !== "session_read_context") {
        return { operation: request.operation };
      }

      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            resolveRemoteAbort();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  const left = new RuntimeIpcPeer({ input: rightToLeft, output: leftToRight });
  const controller = new AbortController();
  const pending = left.request("session_read_context", {}, controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  await remoteAborted;
  await expect(
    left.request("session_read_events", {}, AbortSignal.timeout(1_000)),
  ).resolves.toEqual({ operation: "session_read_events" });
  right.end();
  left.end();
});

it("rejects an instance or nonce mismatch before serving requests", async () => {
  const runtimeToBroker = new PassThrough();
  const brokerToRuntime = new PassThrough();
  const identity = {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime" as const,
  };
  const traces = new TraceRecorder();
  const gateway = new RuntimeBrokerGateway(
    {
      authorize: () => true,
      approveCommand: async () => ({ approved: true }),
      modelProvider: () => ({
        model: "unused",
        provider: { run: async () => ({ output: [], text: "" }) },
      }),
    },
    traces,
  );
  new RuntimeIpcBrokerSession(
    { input: runtimeToBroker, output: brokerToRuntime },
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
  await expect(
    connectAgentRuntime(
      { input: brokerToRuntime, output: runtimeToBroker },
      identity,
      "ffffffffffffffffffffffffffffffff",
      AbortSignal.timeout(1_000),
    ),
  ).rejects.toBeInstanceOf(RuntimeIpcError);
});

it("closes a broker session when any event arrives before runtime hello", async () => {
  const runtimeToBroker = new PassThrough();
  const brokerToRuntime = new PassThrough();
  const identity = {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime" as const,
  };
  const traces = new TraceRecorder();
  const gateway = new RuntimeBrokerGateway(
    {
      authorize: () => true,
      approveCommand: async () => ({ approved: true }),
      modelProvider: () => ({
        model: "unused",
        provider: { run: async () => ({ output: [], text: "" }) },
      }),
    },
    traces,
  );
  const session = new RuntimeIpcBrokerSession(
    { input: runtimeToBroker, output: brokerToRuntime },
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

  runtimeToBroker.write(
    `${JSON.stringify({
      type: "event",
      event: "runtime_state",
      state: "ready",
    })}\n`,
  );
  await expect(
    session.startTask(
      {
        workspace: "C:\\workspace",
        prompt: "test",
        settings: {
          model: "test",
          maxSteps: 1,
          commandTimeoutMs: 1_000,
          contextChars: 1_000,
          outputChars: 1_000,
        },
      },
      AbortSignal.timeout(1_000),
    ),
  ).rejects.toThrow("事件早于身份认证");
});

it("proxies a model request across a real child process", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.resolve("tests/fixtures/runtime-ipc-child.ts")],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const identity = {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime" as const,
  };
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
              limits: {
                max_context_window_tokens: 4096,
                max_output_tokens: 1024,
              },
            };
          },
          async run(_input, _instructions, _tools, _signal, onDelta) {
            onDelta("hello");

            return { output: [], text: "hello" };
          },
        },
      }),
    },
    traces,
  );
  let completed = false;
  new RuntimeIpcBrokerSession(
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
      appendSessionEvent: async () => undefined,
      saveContext: async () => undefined,
      readContext: async () => [],
      readEvents: async () => [],
      latestContextSnapshot: async () => undefined,
      readContextSnapshot: async () => undefined,
      compactContext: async () => undefined,
      runtimeCompleted: async (_runtime, result) => {
        completed = result.status === "completed";
      },
    },
  );
  const exit = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  expect(Buffer.concat(errors).toString("utf8")).toBe("");
  expect(completed).toBe(true);
  expect(exit).toBe(0);
});
