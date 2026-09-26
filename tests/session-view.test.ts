/**
 * 验证浏览器连接层的增量会话投影，不访问服务或真实模型。
 * 1. snapshot/event 夹具构造有序持久事件及任务状态。
 * 2. 分批、重复推送与全量重建必须得到相同的时间线、工具状态和统计。
 * 3. 已发布视图保持不变；追加期间旧正文不可重读，空增量复用视图。
 * 4. 替换与跨会话数据检查保证恢复和切换不会混合事件。
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

it.each([3000, 12000, 50000])(
  "only consumes new bodies after loading %i events",
  (size) => {
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
  },
);

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
