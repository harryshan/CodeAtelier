/**
 * 验证后续 tracing 的模型关联、审批与容量边界，使用纯假输入和内存 Recorder。
 * 1. 模型请求、首流事件及首文本必须共享 ID，后台辅助请求不能取代工具来源。
 * 2. 人工审批的等待与决定保留安全元信息，不包含命令或授权指纹。
 * 3. 容量耗尽只影响诊断，返回可安全结束的句柄并明确报告丢弃。
 * 4. 内存 IPC 观察往返/取消/计数归零；合成 Node 子进程验证取消和直子退出，不推导后代清理。
 * 测试不连接模型、不运行用户命令，不依赖真实凭据。
 */
import { expect, it } from "vitest";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { tracedModelProvider } from "../src/tracing/model-provider.js";
import { ApprovalManager } from "../src/permissions/approval-manager.js";
import { PassThrough } from "node:stream";
import { RuntimeIpcPeer } from "../src/sandbox/runtime-ipc-peer.js";
import { withTraceContext } from "../src/tracing/context.js";
import { executeProcess } from "../src/tools/process.js";
import { temp } from "./fixtures/helpers.js";

it("records IPC request and handler identity and bytes without response bodies", async () => {
  const traces = new TraceRecorder();
  traces.startTask("task", "session");
  const outgoing = new PassThrough();
  const incoming = new PassThrough();
  const trace = { recorder: traces, taskId: "task" };
  const server = new RuntimeIpcPeer({
    input: outgoing,
    output: incoming,
    trace,
    handleRequest: async () => "PRIVATE_RESPONSE",
  });
  const client = new RuntimeIpcPeer({
    input: incoming,
    output: outgoing,
    trace,
  });
  try {
    const { requestId, result } = client.startRequest(
      "session_read_context",
      {},
      new AbortController().signal,
    );
    expect(await result).toBe("PRIVATE_RESPONSE");
    const events = traces.exportTask("task")!.traceEvents;
    for (const name of ["ipc.request", "ipc.handler"]) {
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name,
            ph: "b",
            args: expect.objectContaining({ requestId, status: "ok" }),
          }),
        ]),
      );
    }

    expect(events.some((e) => e.name === "ipc.frame" && e.args.bytes > 0)).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESPONSE");
  } finally {
    client.end();
    server.end();
  }
});

it("correlates model stream milestones and capabilities without serializing input", async () => {
  const traces = new TraceRecorder();
  traces.startTask("task", "session");
  const provider = tracedModelProvider(
    {
      async getCapabilities() {
        return undefined;
      },
      async run(_input, _instructions, _tools, _signal, delta, options) {
        options?.onStreamEvent?.();
        delta("fixture");

        return { output: [], text: "fixture" };
      },
    },
    traces,
    { taskId: "task", purpose: "task", model: "fixture", subagentId: "child" },
  );
  const signal = new AbortController().signal;
  await provider.getCapabilities?.(signal);
  await provider.run(
    [
      {
        toJSON() {
          throw new Error("must not serialize");
        },
        text: "private",
      },
    ],
    "",
    [],
    signal,
    () => {},
  );
  const events = traces.exportTask("task")!.traceEvents;
  const request = events.find((e) => e.name === "llm.request" && e.ph === "b");
  for (const name of ["llm.first_event", "llm.first_output"]) {
    const event = events.find((e) => e.name === name);
    expect(event).toMatchObject({
      tid: request.tid,
      args: { requestId: request.args.requestId, spanId: request.args.spanId },
    });
    expect(event.args.requestId).toBeTruthy();
  }

  expect(
    events.some((e) => e.name === "llm.capabilities" && e.ph === "b"),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("private");
});

it("traces human approval and grant reuse without retaining the subject", async () => {
  const traces = new TraceRecorder();
  traces.startTask("task", "session");
  const approvals = new ApprovalManager(() => {}, undefined, undefined, traces);
  const signal = new AbortController().signal;
  const data = {
    sessionId: "session",
    taskId: "task",
    tool: "command",
    description: "PRIVATE_COMMAND",
  };
  const pending = approvals.request(data, signal, "PRIVATE_GRANT");
  approvals.decide(approvals.list()[0].id, "session");
  expect(await pending).toBe(true);
  expect(await approvals.request(data, signal, "PRIVATE_GRANT")).toBe(true);
  const events = traces.exportTask("task")!.traceEvents;
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "approval.human_wait",
        ph: "b",
        args: expect.objectContaining({ decision: "session" }),
      }),
      expect.objectContaining({ name: "approval.reused" }),
    ]),
  );
  expect(JSON.stringify(events)).not.toContain("PRIVATE_");
});

it.each(["approve", "reject"] as const)(
  "correlates automatic approval decision %s to its tool",
  async (decision) => {
    const traces = new TraceRecorder();
    traces.startTask("task", "session");
    const span = traces.startSpan("task", {
      name: "tool.node",
      category: "tool",
      track: "tool",
      attributes: { callId: "call" },
    });
    const approvals = new ApprovalManager(
      () => {},
      async () => ({ decision, reason: "PRIVATE_REASON" }),
      undefined,
      traces,
    );
    const result = withTraceContext(traces, span, () =>
      approvals.request(
        {
          taskId: "task",
          sessionId: "session",
          tool: "command",
          description: "PRIVATE_COMMAND",
        },
        new AbortController().signal,
      ),
    );
    if (decision === "approve") {
      expect(await result).toBe(true);
    } else {
      await expect(result).rejects.toThrow();
    }

    const events = traces.exportTask("task")!.traceEvents;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "approval.decision",
          args: expect.objectContaining({ callId: "call", decision }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  },
);

it("bounds retained trace data while dropped span handles remain safe", () => {
  const traces = new TraceRecorder({ maxRecords: 8, maxBytes: 4096 });
  traces.startTask("task", "session");
  for (let i = 0; i < 100; i++) {
    const span = traces.startSpan("task", {
      name: "work",
      category: "test",
      track: "test",
      attributes: { parameters: { text: "x".repeat(10000) } },
    });
    expect(span).toBeDefined();
    traces.endSpan(span, "ok");
  }

  traces.finishTask("task", "ok");
  const trace = traces.exportTask("task")!;
  expect(trace.metadata.droppedRecords).toBeGreaterThan(0);
  expect(
    trace.traceEvents.filter((e) => e.ph === "b").length,
  ).toBeLessThanOrEqual(8);
  expect(JSON.stringify(trace).length).toBeLessThan(20000);
});

it("marks oversized diagnostic attributes without changing supplied parameters", () => {
  const recorder = new TraceRecorder();
  recorder.startTask("task", "session");
  const parameters = {
    content: "x".repeat(70000),
    password: "PRIVATE_PASSWORD",
    items: Array.from({ length: 5000 }, (_, i) => i),
  };
  recorder.startSpan("task", {
    name: "tool",
    category: "tool",
    track: "tool",
    attributes: { parameters },
  });
  const event = recorder
    .exportTask("task")!
    .traceEvents.find((e) => e.name === "tool" && e.ph === "b");
  expect(event.args.traceAttributesTruncated).toBe(true);
  expect(event.args.parameters.password).toBe("[REDACTED]");
  expect(JSON.stringify(event).length).toBeLessThan(20000);
  expect(parameters.content).toHaveLength(70000);
  expect(parameters.items).toHaveLength(5000);
});

it("records IPC cancellation without claiming remote completion", async () => {
  const traces = new TraceRecorder();
  traces.startTask("task", "session");
  const outgoing = new PassThrough();
  const incoming = new PassThrough();
  const trace = { recorder: traces, taskId: "task" };
  let handlerFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    handlerFinished = resolve;
  });
  const server = new RuntimeIpcPeer({
    input: outgoing,
    output: incoming,
    trace,
    handleRequest: async (_request, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      handlerFinished();
    },
  });
  const client = new RuntimeIpcPeer({
    input: incoming,
    output: outgoing,
    trace,
  });
  const controller = new AbortController();
  try {
    const result = client.request(
      "session_read_context",
      {},
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toThrow();
    await finished;
    const events = traces.exportTask("task")!.traceEvents;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ipc.request",
          ph: "b",
          args: expect.objectContaining({
            status: "cancelled",
            remoteCompletion: "unknown",
          }),
        }),
        expect.objectContaining({ name: "ipc.cancel_received" }),
      ]),
    );
    expect(
      events.filter((e) => e.name === "ipc.inflight").at(-1).args,
    ).toMatchObject({ pending: 0, handling: 0 });
  } finally {
    client.end();
    server.end();
  }
});

it("observes cancelled host process exit without asserting descendant cleanup", async () => {
  const traces = new TraceRecorder();
  const root = traces.startTask("task", "session");
  const controller = new AbortController();
  const workspace = await temp();
  await expect(
    withTraceContext(traces, root, () =>
      executeProcess(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        workspace,
        controller.signal,
        0,
        100,
        () => {},
        {},
        () => controller.abort(),
      ),
    ),
  ).rejects.toThrow();
  const events = traces.exportTask("task")!.traceEvents;
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "process.cancel",
        ph: "b",
        args: expect.objectContaining({
          status: "cancelled",
          directChildExited: true,
          treeCleanup: "unknown",
        }),
      }),
      expect.objectContaining({ name: "process.direct_exit" }),
    ]),
  );
});
