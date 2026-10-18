/**
 * 验证用户下载的单一英文 trace 投影，与 TraceRecorder 的底层采集回归分开。
 * 只用合成事件和真实采集器，不读取用户归档、不调用模型、不改变时钟或磁盘。
 *
 * 1. span/archive 生成固定时间的异步片段，验证分类、降噪、异常保留和参数排除。
 * 2. 跨子系统串行工作共用 Work；Sandbox/调度/读取内部细节省略，异常及 10 ms 边界单独验证。
 * 3. 交叉/包含/并行/零时长验证真实时间及进程归属，串行操作复用轨道而非逐调用建行。
 * 4. 旧 X、B/E 与未知结束验证兼容及不伪造终态；采集器集成验证实际产物可转换且不变更源。
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
    displayedSpans: 6,
    hiddenSpans: 6,
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

it("shares one Work lane across serial sandbox, tools, waits, context and persistence", () => {
  const operations = [
    "sandbox.native_launch",
    "tool.read_file",
    "tool.edit_files",
    "tool.run_command",
    "approval.human_wait",
    "context.prepare",
    "context.compaction",
    "tool.result_persist",
    "sandbox.cleanup",
  ];
  const result = simplifyTrace(
    archive(
      operations.flatMap((name, index) =>
        span(name, index * 20_000, (index + 1) * 20_000),
      ),
    ),
  );
  const slices = result.traceEvents.filter((event) => event.ph === "X");
  const tracks = result.traceEvents.filter(
    (event) => event.name === "thread_name",
  );

  expect(tracks).toEqual([expect.objectContaining({ args: { name: "Work" } })]);
  expect(slices).toHaveLength(operations.length);
  expect(new Set(slices.map((event) => event.tid)).size).toBe(1);
  expect(slices.map((event) => event.cat)).toEqual(
    operations.map(() => "Work"),
  );
  expect(slices.map((event) => event.ts)).toEqual(
    operations.map((_, index) => index * 20_000),
  );
});

it("omits routine sandbox, scheduling, database and read internals even when slow", () => {
  const result = simplifyTrace(
    archive([
      ...span("sandbox.native_launch", 0, 100_000),
      ...span("sandbox.internal_setup", 0, 100_000),
      ...span("sandbox.cleanup", 100_000, 200_000),
      ...span("sandbox.revoke_access", 110_000, 190_000),
      ...span("sandbox.account_generation.drain", 120_000, 180_000),
      ...span("tool.read_file", 200_000, 300_000),
      ...span("read_file.bytes", 210_000, 290_000),
      ...span("tool.dependency_wait", 200_000, 300_000),
      ...span("tool.slot_wait", 200_000, 300_000),
      ...span("store.save", 200_000, 300_000),
    ]),
  );
  const slices = result.traceEvents.filter((event) => event.ph === "X");

  expect(
    slices.map((event) => (event.args as { operation: string }).operation),
  ).toEqual(["sandbox.native_launch", "sandbox.cleanup", "tool.read_file"]);
  expect(
    result.traceEvents.filter((event) => event.name === "thread_name"),
  ).toHaveLength(1);
  expect(result.metadata).toMatchObject({ displayedSpans: 3, hiddenSpans: 7 });
});

it.each(["error", "cancelled", "unknown"])(
  "retains suppressed internal stages with %s outcomes",
  (status) => {
    const operations = [
      "sandbox.revoke_access",
      "tool.dependency_wait",
      "read_file.bytes",
      "store.save",
    ];
    const result = simplifyTrace(
      archive(
        operations.flatMap((name, index) =>
          span(name, index, index, { status }),
        ),
      ),
    );
    const slices = result.traceEvents.filter((event) => event.ph === "X");

    expect(slices).toHaveLength(operations.length);
    expect(
      slices.every((event) => String(event.name).endsWith(`[${status}]`)),
    ).toBe(true);
    expect(result.metadata.hiddenSpans).toBe(0);
  },
);

it("filters short supporting work at 10 ms but keeps real tools and context compaction", () => {
  const operations = [
    "context.prepare",
    "context.request",
    "tool.result_persist",
    "sandbox.mxc.preflight",
    "sandbox.mxc.launch",
    "sandbox.mxc.cleanup",
  ];
  const result = simplifyTrace(
    archive([
      ...operations.flatMap((name) => [
        ...span(name, 0, 9_999, {}, 1, `${name}-short`),
        ...span(name, 10_000, 20_000, {}, 1, `${name}-long`),
      ]),
      ...span("tool.read_file", 30_000, 30_001),
      ...span("context.compaction", 30_001, 30_002),
    ]),
  );
  const slices = result.traceEvents.filter((event) => event.ph === "X");

  expect(slices.map((event) => event.ts)).toEqual([
    ...operations.map(() => 10_000),
    30_000,
    30_001,
  ]);
  expect(result.metadata.hiddenSpans).toBe(operations.length);
});

it("preserves contained and identical concurrent reads instead of collapsing independent calls", () => {
  const result = simplifyTrace(
    archive([
      ...span("tool.read_file", 0, 100, { callId: "outer" }, 1, "outer"),
      ...span("tool.read_file", 10, 90, { callId: "inner" }, 1, "inner"),
      ...span("tool.read_file", 10, 90, { callId: "peer" }, 1, "peer"),
    ]),
  );
  const slices = result.traceEvents.filter((event) => event.ph === "X");

  expect(slices.map((event) => [event.ts, event.dur])).toEqual([
    [0, 100],
    [10, 80],
    [10, 80],
  ]);
  expect(new Set(slices.map((event) => event.tid)).size).toBe(3);
  expect(
    slices.map((event) => (event.args as { callId: string }).callId),
  ).toEqual(["outer", "inner", "peer"]);
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
