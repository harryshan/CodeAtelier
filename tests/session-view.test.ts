/**
 * 验证浏览器连接层的增量会话投影，不访问服务或真实模型。
 * 1. snapshot/event 夹具构造有序持久事件及任务状态。
 * 2. 分批、重复推送与全量重建必须得到相同的时间线、工具状态和统计。
 * 3. 已发布视图保持不变；追加期间旧正文不可重读，空增量复用视图。
 * 4. 替换与跨会话数据检查保证恢复和切换不会混合事件；旧页前插保留实时游标、去重及全部已加载事件。
 * 5. 终态任务统一折叠过程，活动任务保持展开，状态独立更新及历史重建保持一致且不丢中断提示。
 * 6. Broker 宿主命令输出按任务/调用归属聚合，覆盖交错输出、终态、旧无 ID 事件和历史重建。
 */

import { expect, it } from "vitest";
import type { Event, Snapshot } from "../src/shared/types.js";
import { SessionViewModel } from "../src/web/session-view.js";

const date = "2026-09-26T00:00:00.000Z";

function event(id: number, type: string, data: unknown): Event {
  return { id, type, data, sessionId: "s", taskId: "t", createdAt: date };
}

function snapshot(events: Event[]): Snapshot {
  return {
    session: {
      id: "s",
      title: "test",
      titleState: "completed",
      workspace: "/test",
      createdAt: date,
      updatedAt: date,
    },
    tasks: [
      {
        id: "t",
        sessionId: "s",
        status: "running",
        subagentsEnabled: false,
        createdAt: date,
        startedAt: date,
        finishedAt: null,
      },
    ],
    approvals: [],
    events,
  };
}

it("prepends history without losing live metadata, cursor or previously loaded events", () => {
  const model = new SessionViewModel("s");
  const events = Array.from({ length: 1400 }, (_, index) =>
    event(index + 1, "user", { text: `message ${index + 1}` }),
  );
  const page = (
    items: Event[],
    cursor: number,
    hasOlder: boolean,
  ): Snapshot => ({
    ...snapshot(items),
    history: { cursor, highWater: cursor, hasOlder, hasNewer: false },
  });
  model.update(page(events.slice(700), 1400, true));
  const live = model.update(
    page([event(1401, "user", { text: "live" })], 1401, false),
  );
  const older = page(events.slice(0, 701), 1400, false);
  older.tasks = [];

  const merged = model.prepend(older);
  expect(merged.events.map((item) => item.id)).toEqual(
    Array.from({ length: 1401 }, (_, index) => index + 1),
  );
  expect(model.cursor).toBe(1401);
  expect(merged.tasks).toEqual(live.tasks);
  expect(merged.history).toEqual({
    cursor: 1401,
    highWater: 1401,
    hasOlder: false,
    hasNewer: false,
  });
  expect(live.events).toHaveLength(701);
  const next = model.update(
    page([event(1402, "user", { text: "next" })], 1402, false),
  );
  expect(next.events).toHaveLength(1402);
  expect(next.events[0].id).toBe(1);
  expect(next.history?.hasOlder).toBe(false);
  expect(() =>
    model.prepend({ ...older, session: { ...older.session, id: "other" } }),
  ).toThrow();
});

it("matches full reconstruction across batches, retries and duplicate delivery", () => {
  const events = [
    event(1, "user", { text: "start" }),
    event(2, "delta", { step: 1, attempt: 1, text: "failed" }),
    event(3, "notice", { step: 1, attempt: 1, text: "retry" }),
    event(4, "delta", { step: 1, attempt: 2, text: "hello" }),
    event(5, "delta", { step: 1, attempt: 2, text: " world" }),
    event(6, "assistant", { step: 1, attempt: 2, text: "hello world" }),
    event(7, "tool_start", { name: "run_command", callId: "c", batchId: "b" }),
    event(8, "tool_state", { callId: "c", state: "queued" }),
    event(9, "tool_state", { callId: "c", batchId: "other", state: "failed" }),
    event(10, "command_output", { callId: "c", text: "output" }),
    event(11, "tool_result", {
      name: "run_command",
      callId: "c",
      result: { exitCode: 0 },
    }),
    event(12, "edit_progress", { batchId: "e", path: "a", status: "unknown" }),
    event(13, "edit_progress", { batchId: "e", path: "a", status: "written" }),
  ];
  const model = new SessionViewModel("s");
  let actual = model.update(snapshot([]));
  for (const item of events) {
    actual = model.update(snapshot([item, item]));
  }

  const expected = new SessionViewModel("s").update(snapshot(events));
  expect({ ...actual, statistics: actual.statistics(1000) }).toEqual({
    ...expected,
    statistics: expected.statistics(1000),
  });
  expect(actual.timeline.toolStatuses.get(7)?.label).toBe(
    "已显示，等待可用执行槽",
  );
  expect(actual.timeline.outputEvents.cards.get(7)?.output).toBe("output");
  expect(
    actual.timeline.entries.filter((entry) => entry.kind === "streaming"),
  ).toEqual([
    { key: "streaming:t:1:1", kind: "streaming", taskId: "t", text: "failed" },
  ]);
});

it("associates interleaved Broker command output and results with their calls", () => {
  const events = [
    event(1, "tool_start", { name: "run_with_permissions", callId: "a" }),
    event(2, "tool_start", { name: "run_with_permissions", callId: "b" }),
    event(3, "tool_start", { name: "run_command", callId: "c" }),
    event(4, "capability_output", { callId: "b", text: "b stdout\n" }),
    event(5, "command_output", { callId: "c", text: "ordinary\n" }),
    event(6, "capability_output", { callId: "a", text: "a stdout\n" }),
    event(7, "capability_output", { callId: "b", text: "b stderr\n" }),
    event(8, "tool_result", {
      name: "run_with_permissions",
      callId: "b",
      result: { exitCode: 7, truncated: true },
    }),
    event(9, "capability_output", { callId: "a", text: "a stderr\n" }),
    event(10, "tool_result", {
      name: "run_with_permissions",
      callId: "a",
      result: { error: "cancelled" },
    }),
  ];
  const model = new SessionViewModel("s");
  const live = model.update(snapshot(events.slice(0, 7)));
  expect(live.timeline.outputEvents.cards.get(2)).toEqual({
    output: "b stdout\nb stderr\n",
  });

  const finished = model.update(snapshot(events.slice(7)));
  expect(finished.timeline.outputEvents.cards.get(1)).toEqual({
    output: "a stdout\na stderr\n",
    result: events[9],
  });
  expect(finished.timeline.outputEvents.cards.get(2)).toEqual({
    output: "b stdout\nb stderr\n",
    result: events[7],
  });
  expect(finished.timeline.outputEvents.cards.get(3)?.output).toBe(
    "ordinary\n",
  );
  expect(finished.timeline.entries).toHaveLength(3);
  expect(live.timeline.outputEvents.cards.get(2)?.result).toBeUndefined();
  expect(new SessionViewModel("s").update(snapshot(events)).timeline).toEqual(
    finished.timeline,
  );
});

it("preserves legacy Broker output and unmatched output without losing final-only results", () => {
  const events = [
    event(1, "capability_output", { callId: "missing", text: "orphan" }),
    event(2, "tool_start", { name: "run_with_permissions", callId: "legacy" }),
    event(3, "capability_output", { text: "legacy stdout\n" }),
    event(4, "tool_result", {
      name: "run_with_permissions",
      callId: "legacy",
      result: { output: "legacy stdout\n", exitCode: 0 },
    }),
    event(5, "tool_start", { name: "run_with_permissions", callId: "final" }),
    event(6, "tool_result", {
      name: "run_with_permissions",
      callId: "final",
      result: { output: "final-only output", exitCode: 0 },
    }),
  ];
  const view = new SessionViewModel("s").update(snapshot(events));
  expect(view.timeline.outputEvents.cards.get(2)?.output).toBe(
    "legacy stdout\n",
  );
  expect(view.timeline.outputEvents.cards.get(5)).toEqual({
    output: "",
    result: events[5],
  });
  expect(view.timeline.entries).toHaveLength(3);
  expect(view.timeline.entries[0]).toMatchObject({ event: events[0] });
});

it("does not reread old bodies or mutate a published view on append", () => {
  const old = event(1, "delta", { step: 1, text: "old" });
  const model = new SessionViewModel("s");
  const before = model.update(snapshot([old]));
  Object.defineProperty(old, "data", {
    get() {
      throw new Error("old body read");
    },
  });
  const after = model.update(
    snapshot([event(2, "delta", { step: 1, text: " new" })]),
  );
  expect(before.timeline.entries[0]).toMatchObject({ text: "old" });
  expect(after.timeline.entries[0]).toMatchObject({ text: "old new" });
  const unchanged = model.update(snapshot([]));
  expect(unchanged.events).toBe(after.events);
  expect(unchanged.timeline).toBe(after.timeline);
});

it("rebuilds explicit replacements and rejects another session", () => {
  const model = new SessionViewModel("s");
  model.update(snapshot([event(1, "user", { text: "old" })]));
  const replaced = model.update(
    snapshot([event(1, "user", { text: "replacement" })]),
    true,
  );
  expect(replaced.events[0].data.text).toBe("replacement");
  expect(() =>
    model.update({
      ...snapshot([]),
      session: { ...snapshot([]).session, id: "other" },
    }),
  ).toThrow();
});

it("reconciles legacy usage when explicit requests arrive and keeps clock work independent of events", () => {
  const model = new SessionViewModel("s");
  const usage = event(1, "model_usage", {
    step: 1,
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
  });
  const before = model.update(snapshot([usage]));
  expect(before.statistics(Date.parse(date)).llmRequests).toBe(1);
  Object.defineProperty(usage, "data", {
    get() {
      throw new Error("old usage read");
    },
  });
  const after = model.update(
    snapshot([
      event(2, "model_request", { step: 1, attempt: 1 }),
      event(3, "model_request", { step: 1, attempt: 2 }),
    ]),
  );
  expect(after.statistics(Date.parse(date) + 2500)).toMatchObject({
    llmRequests: 2,
    llmRounds: 1,
    totalTokens: 110,
    totalRunMs: 2500,
    cachedInputTokens: undefined,
    cacheDetailsComplete: false,
  });
  expect(before.statistics(Date.parse(date)).llmRequests).toBe(1);
  const finished = snapshot([event(4, "task_end", {})]);
  finished.tasks[0] = {
    ...finished.tasks[0],
    status: "completed",
    finishedAt: "2026-09-26T00:00:04.000Z",
  };
  const last = model.update(finished);
  expect(last.statistics(Date.parse(date) + 100000).totalRunMs).toBe(4000);
});

it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
  "collapses %s processes on status-only updates and history reload",
  (status) => {
    const model = new SessionViewModel("s");
    const events = [
      event(1, "user", { text: "request" }),
      event(2, "notice", { text: "process detail" }),
      event(3, "assistant", { text: "last complete reply" }),
    ];
    const active = model.update(snapshot(events));
    expect(
      active.timeline.entries.some((entry) => entry.kind === "process"),
    ).toBe(false);

    const ended = snapshot([]);
    ended.tasks[0].status = status;
    const folded = model.update(ended);
    expect(folded.timeline.entries.map((entry) => entry.kind)).toEqual([
      "event",
      "process",
      "event",
      ...(status === "interrupted" ? ["interrupted"] : []),
    ]);
    expect(folded.timeline.entries[1]).toMatchObject({
      entries: [{ kind: "event", event: events[1] }],
    });
    expect(folded.events).toEqual(events);
    const historical = new SessionViewModel("s").update({ ...ended, events });
    expect(historical.timeline.entries).toEqual(folded.timeline.entries);

    for (const activeStatus of ["queued", "running", "waiting"] as const) {
      const next = snapshot([]);
      next.tasks[0].status = activeStatus;
      const unfolded = model.update(next);
      expect(unfolded.timeline.entries.map((entry) => entry.kind)).toEqual([
        "event",
        "event",
        "event",
      ]);
    }

    expect(folded.timeline.entries[1].kind).toBe("process");
  },
);

it("preserves legacy output, batch wildcard precedence, completed groups and immutable cards", () => {
  const model = new SessionViewModel("s");
  const first = model.update(
    snapshot([
      event(1, "user", { text: "start" }),
      event(2, "tool_start", {
        name: "run_command",
        callId: "c",
        batchId: "b",
      }),
      event(3, "tool_state", { callId: "c", batchId: "b", state: "executing" }),
      event(4, "command_output", { text: "legacy output" }),
      event(5, "edit_progress", {
        batchId: "edit",
        path: "a",
        status: "unknown",
      }),
    ]),
  );
  const next = snapshot([
    event(6, "tool_state", { callId: "c", state: "succeeded" }),
    event(7, "tool_result", {
      name: "run_command",
      callId: "c",
      result: { exitCode: 0 },
    }),
    event(8, "edit_progress", {
      batchId: "edit",
      files: [
        { path: "a", status: "written" },
        { path: "b", status: "failed" },
      ],
    }),
    event(9, "assistant", { step: 2, text: "finished" }),
  ]);
  next.tasks[0].status = "completed";
  const second = model.update(next);
  expect(second.timeline.toolStatuses.get(2)?.label).toBe("已完成");
  expect(first.timeline.toolStatuses.get(2)?.label).toBe("正在执行");
  expect(first.timeline.outputEvents.cards.get(2)?.result).toBeUndefined();
  expect(second.timeline.outputEvents.cards.get(2)?.output).toBe(
    "legacy output",
  );
  expect(first.timeline.editBatches.get("edit")?.files.get("a")?.status).toBe(
    "unknown",
  );
  expect(second.timeline.editBatches.get("edit")?.files.get("a")?.status).toBe(
    "written",
  );
  expect(second.timeline.entries.map((entry) => entry.kind)).toEqual([
    "event",
    "process",
    "event",
  ]);
  const process = second.timeline.entries[1];
  const other = snapshot([
    { ...event(10, "user", { text: "next task" }), taskId: "next" },
  ]);
  other.tasks = [
    ...next.tasks,
    { ...next.tasks[0], id: "next", status: "running" },
  ];
  const third = model.update(other);
  expect(third.timeline.entries[1]).toBe(process);
});

it("only consumes new bodies after loading 50000 events", () => {
  const size = 50_000;
  const history = Array.from({ length: size }, (_, index) =>
    event(index + 1, "delta", { step: 1, text: "x" }),
  );
  const model = new SessionViewModel("s");
  model.update(snapshot(history));
  for (const item of history) {
    Object.defineProperty(item, "data", {
      get() {
        throw new Error("historical body revisited");
      },
    });
  }

  const next = model.update(
    snapshot([event(size + 1, "delta", { step: 1, text: "y" })]),
  );
  expect(next.timeline.entries).toHaveLength(1);
  expect(next.timeline.entries[0]).toMatchObject({
    text: "x".repeat(size) + "y",
  });
  expect(next.statistics(Date.parse(date) + 1000).totalRunMs).toBe(1000);
});

it("orders out-of-order batches, rebuilds late events and maintains sandbox state", () => {
  const model = new SessionViewModel("s");
  model.update(
    snapshot([
      event(3, "notice", { text: "third" }),
      event(1, "user", { text: "first" }),
    ]),
  );
  const state = { mode: "host-process-fallback", reason: "test" };
  const view = model.update(snapshot([event(2, "sandbox_stage", state)]));
  expect(view.events.map((item) => item.id)).toEqual([1, 2, 3]);
  expect(view.latestSandbox).toEqual(state);
  expect(model.cursor).toBe(3);
});
