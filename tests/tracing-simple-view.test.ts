/**
 * 验证用户下载的单一英文 trace 投影，与 TraceRecorder 的底层采集回归分开。
 * 只用合成事件和真实采集器，不读取用户归档、不调用模型、不改变时钟或磁盘。
 *
 * 1. span/archive 生成固定时间的异步片段，验证分类、降噪、异常保留和参数排除。
 * 2. 交叉/并行/零时长验证真实时间及进程归属，串行操作复用轨道而非逐调用建行。
 * 3. 旧 X、B/E 与未知结束验证兼容及不伪造终态；采集器集成验证实际产物可转换且不变更源。
 */

import { expect, it } from "vitest";
import { simplifyTrace } from "../src/tracing/simple-view.js";
import { TraceRecorder } from "../src/tracing/recorder.js";

function span(
  name: string,
  start: number,
  end: number,
  args = {},
  pid = 1,
  id = name,
) {
  const base = { name, cat: "fixture", pid, tid: 9, id2: { local: id } };

  return [
    { ...base, ph: "b", ts: start, args: { status: "ok", ...args } },
    { ...base, ph: "e", ts: end },
  ];
}

function archive(events: unknown[], metadata = {}) {
  return JSON.stringify({
    traceEvents: events,
    metadata: { format: "v2", taskId: "fixture", ...metadata },
  });
}

it("keeps meaningful English phases, removes routine internals and never exports parameters", () => {
  const input = archive(
    [
      ...span("task.run", 0, 100_000),
      ...span("llm.request", 1, 20_000, {
        purpose: "task",
        requestId: "request",
        step: 2,
      }),
      ...span("llm.request", 2, 10_000, { purpose: "title" }, 1, "title"),
      ...span("tool.read_file", 20_000, 30_000, {
        callId: "call",
        parameters: { path: "private.ts", content: "private source" },
      }),
      ...span("context.prepare", 30_000, 30_001),
      ...span("tool.result_persist", 30_001, 30_002),
      ...span("sandbox.handshake", 35_000, 55_000),
      ...span("approval.human_wait", 55_000, 80_000),
      ...span("tool.slot_wait", 55_000, 55_001),
      ...span("store.worker.sql_execute", 80_000, 90_000),
      ...span("read_file.bytes", 20_001, 20_100),
      ...span("ipc.request", 90_000, 95_000),
      { ph: "C", name: "process.resources", ts: 1, pid: 1, args: { rss: 50 } },
      { ph: "n", name: "llm.request", ts: 1, pid: 1, bind_id: 1 },
    ],
    { partial: true, droppedRecords: 4 },
  );
  const result = simplifyTrace(input);
  const slices = result.traceEvents.filter((event) => event.ph === "X");

  expect(slices.map((event) => event.name)).toEqual([
    "Task",
    "Model request",
    "Generate title",
    "Read file",
    "Prepare context",
    "Save tool results",
    "Sandbox handshake",
    "User approval",
  ]);
  expect(
    slices.find((event) => event.name === "Model request")?.args,
  ).toMatchObject({ requestId: "request", step: 2, status: "ok" });
  expect(result.metadata).toMatchObject({
    view: "simple",
    partial: true,
    droppedRecords: 4,
    displayedSpans: 8,
    hiddenSpans: 4,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(
    result.traceEvents.every((event) => ["M", "X"].includes(String(event.ph))),
  ).toBe(true);
});

it("preserves failures, cancellation and unknown outcomes even in hidden or short stages", () => {
  const result = simplifyTrace(
    archive([
      ...span("read_file.bytes", 0, 1, { status: "error", errorName: "Error" }),
      ...span("tool.slot_wait", 2, 2, { status: "cancelled" }),
      ...span("ipc.request", 3, 5, { status: "unknown" }),
      {
        name: "process.failure",
        ph: "i",
        pid: 1,
        ts: 6,
        args: { status: "error" },
      },
    ]),
  );
  const slices = result.traceEvents.filter((event) => event.ph === "X");

  expect(slices.map((event) => event.name)).toEqual([
    "Read file bytes [error]",
    "Tool slot [cancelled]",
    "Ipc request [unknown]",
    "Process failure [error]",
  ]);
  expect(slices.map((event) => event.dur)).toEqual([1, 0, 2, 0]);
  expect(result.metadata.hiddenSpans).toBe(0);
});

it("reuses lanes across tool names and separates crossing intervals without moving time or process", () => {
  const result = simplifyTrace(
    archive([
      ...span("tool.read_file", 0, 30, { callId: "first" }, 1, "same"),
      ...span("tool.edit_files", 10, 40, { callId: "second" }),
      ...span("tool.run_command", 30, 50, { callId: "third" }),
      ...span("tool.read_file", 0, 60, { callId: "runtime" }, 2, "same"),
      ...span("tool.read_file", 50, 50, { callId: "zero" }, 1, "zero"),
    ]),
  );
  const slices = result.traceEvents.filter((event) => event.ph === "X");
  const first = slices.find(
    (event) => (event.args as { callId: string }).callId === "first",
  )!;
  const second = slices.find(
    (event) => (event.args as { callId: string }).callId === "second",
  )!;
  const third = slices.find(
    (event) => (event.args as { callId: string }).callId === "third",
  )!;

  expect(first).toMatchObject({ pid: 1, ts: 0, dur: 30 });
  expect(second).toMatchObject({ pid: 1, ts: 10, dur: 30 });
  expect(third).toMatchObject({ pid: 1, ts: 30, dur: 20, tid: first.tid });
  expect(first.tid).not.toBe(second.tid);
  expect(slices.find((event) => event.pid === 2)).toMatchObject({
    ts: 0,
    dur: 60,
  });
  expect(
    result.traceEvents.filter((event) => event.name === "thread_name"),
  ).toHaveLength(3);
  for (const left of slices) {
    for (const right of slices) {
      if (left !== right && left.pid === right.pid && left.tid === right.tid) {
        expect(
          Number(left.ts) + Number(left.dur) <= Number(right.ts) ||
            Number(right.ts) + Number(right.dur) <= Number(left.ts),
        ).toBe(true);
      }
    }
  }
});

it("reads old complete and synchronous events and marks unmatched starts unknown", () => {
  const result = simplifyTrace(
    archive([
      {
        name: "tool.read_file",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 0,
        dur: 10,
        args: { status: "ok" },
      },
      { name: "llm.request", ph: "B", pid: 1, tid: 1, ts: 20 },
      { ph: "E", pid: 1, tid: 1, ts: 30, args: { status: "ok" } },
      {
        name: "tool.edit_files",
        ph: "b",
        pid: 1,
        tid: 1,
        ts: 40,
        id: "open",
        args: { status: "ok" },
      },
    ]),
  );
  const slices = result.traceEvents.filter((event) => event.ph === "X");

  expect(slices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Read file", ts: 0, dur: 10 }),
      expect.objectContaining({ name: "Model request", ts: 20, dur: 10 }),
      expect.objectContaining({
        name: "Edit files [unknown]",
        ts: 40,
        dur: 0,
        args: expect.objectContaining({ status: "unknown" }),
      }),
    ]),
  );
  expect(result.metadata.unpairedSpans).toBe(1);
  expect(simplifyTrace(archive([])).traceEvents).toEqual([]);
  expect(() => simplifyTrace("{}")).toThrow("Invalid trace archive");
});

it("projects actual recorder output without mutating the source or inventing a completed state", () => {
  const recorder = new TraceRecorder();
  recorder.startTask("task", "session");
  const tool = recorder.startSpan("task", {
    name: "tool.read_file",
    category: "tool",
    track: "Tool worker 1",
  });
  recorder.endSpan(tool, "ok");
  const source = recorder.exportTask("task")!;
  const serialized = JSON.stringify(source);
  const result = simplifyTrace(serialized);

  expect(JSON.stringify(source)).toBe(serialized);
  expect(result.traceEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Task [unknown]", ph: "X" }),
      expect.objectContaining({ name: "Read file", ph: "X" }),
    ]),
  );
  expect(recorder.hasTask("task")).toBe(true);
});
