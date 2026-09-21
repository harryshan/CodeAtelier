/**
 * 验证 Agent Runtime IPC 的有界 framing、请求关联、取消和真实子进程 stdio 路由。
 * 内存流用例覆盖协议错误，独立 Node fixture 覆盖 model request/delta/response 跨进程，但不冒充 Windows Named Pipe 身份验收。
 *
 * 1. 双向 PassThrough peer 完成请求并拒绝未知响应、畸形 JSON 和超限半帧。
 * 2. RuntimeGitPushClient 只发送有界 PushSpec，并校验 Broker 返回的固定进程结果。
 * 3. AbortSignal 发送 request_cancel，中止远端同 requestId handler；竞态迟到响应不会破坏后续请求。
 * 4. Runtime trace event 只接受固定 context 阶段和有界元数据，任意名称或文本字段关闭通道；合法消息触发 observer 异常也安全关闭而非产生未处理拒绝。
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
} from "../src/sandbox/runtime-tool-adapters.js";

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

it("sends only a structured push spec to the broker", async () => {
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
  const spec = {
    remote: "origin",
    remoteUrl: "https://example.com/repository.git",
    host: "example.com",
    refspec: "HEAD:refs/heads/main",
    objectId: "a".repeat(40),
  };

  await expect(
    new RuntimeGitPushClient(left).execute(
      spec,
      "push-call",
      new AbortController().signal,
    ),
  ).resolves.toEqual({ output: "pushed", exitCode: 0, truncated: false });
  expect(received).toMatchObject({
    operation: "git_push",
    body: { toolCallId: "push-call", spec },
  });
  right.end();
  left.end();
});

it("sends a bounded capability command with its reason and tool call", async () => {
  const leftToRight = new PassThrough();
  const rightToLeft = new PassThrough();
  let received: unknown;
  const right = new RuntimeIpcPeer({
    input: leftToRight,
    output: rightToLeft,
    handleRequest: async (request) => {
      received = request;

      return {
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
    permissions: {
      readRoots: ["C:\\approved-read"],
      writeRoots: ["C:\\approved-write"],
      httpsHost: "example.test",
    },
    reason: "需要处理工作区外的已审核对象。",
  };

  await expect(
    new RuntimeCapabilityClient(left).execute(
      request,
      "capability-call",
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({
    executionInstanceId: "capability-1",
    output: "done",
  });
  expect(received).toMatchObject({
    operation: "run_with_permissions",
    body: { toolCallId: "capability-call", request },
  });
  right.end();
  left.end();
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
      attributes: { step: 1, inputItems: 3 },
    })}\n`,
  );
  await expect.poll(() => events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "trace_span_start",
    name: "context.prepare",
  });

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
      executeCapabilityCommand: async () => ({
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
      executeCapabilityCommand: async () => ({
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
