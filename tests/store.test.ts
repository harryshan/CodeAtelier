/**
 * 在临时 SQLite 文件上检查 Store 的数据隔离、事务回滚和重启行为。
 * 通过关闭后重新创建 Store 验证磁盘记录，不使用数据库替身。
 *
 * 1. 创建两个会话，核对各自事件、读取游标和上下文。
 * 2. 后续分片取锁失败时释放已取得的事务；在保存任务和事件的事务中制造失败，确认整笔事务回滚。
 * 3. 保存排队、运行和终态任务后重启，确认所有未完成任务变为 interrupted。
 * 4. 大于同步阈值的事件和上下文由 Worker 读取，验证结果与同步接口相同且数据库可正常关闭。
 * 5. 逐步保存 replay 模型/工具捕获并导出单任务 case；旧事件只能形成明确的 legacy case。
 * 6. 以小容量阈值触发新会话分片，确认旧分片的上下文仍可由 Worker 读取，并在重启后发现全部分片。
 * 7. 任务级 subagent 选择写入队列后保持布尔类型；模拟旧表缺列并检查跨分片迁移默认关闭。
 *
 * 重启要保留已有终态和上下文，不能把其他会话的数据混进来。
 */

import { it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

it("releases earlier shard transactions when a later shard is locked", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  const store = new Store(file, { maxShardBytes: 1 });
  const first = store.create(root, "first");
  const firstDb = store.db;
  store.create(root, "second");
  const blocker = new DatabaseSync(path.join(root, "history-000001.sqlite"));

  try {
    blocker.exec("BEGIN IMMEDIATE");
    expect(() => store.transaction(() => store.createTask(first.id))).toThrow();
    expect(firstDb.isTransaction).toBe(false);
    blocker.exec("ROLLBACK");

    const task = store.transaction(() => store.createTask(first.id));
    expect(store.task(task.id)?.status).toBe("queued");
  } finally {
    blocker.close();
    store.close();
  }
});

it("keeps sessions isolated and supports ordered event cursors", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "db"));

  try {
    const primarySession = store.create(root, "a");
    const otherSession = store.create(root, "b");
    const task = store.createTask(primarySession.id);
    const first = store.event(primarySession.id, task.id, "user", {
      text: "one",
    });
    const second = store.event(primarySession.id, task.id, "assistant", {
      text: "two",
    });

    store.saveContext(primarySession.id, [{ role: "user", content: "one" }]);

    expect(store.events(primarySession.id, first.id)).toEqual([second]);
    expect(store.events(otherSession.id)).toEqual([]);
    expect(store.context(otherSession.id)).toEqual([]);
    expect(store.get("missing")).toBeUndefined();
    expect(
      store
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual([primarySession.id, otherSession.id].sort());
  } finally {
    store.close();
  }
});

it("rolls back task creation and events together when persistence fails", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "db"));

  try {
    const session = store.create(root, "s");

    expect(() =>
      store.transaction(() => {
        const task = store.createTask(session.id);

        store.event(session.id, task.id, "user", { text: "not committed" });
        throw new Error("disk fault");
      }),
    ).toThrow("disk fault");
    expect(store.tasks(session.id)).toEqual([]);
    expect(store.events(session.id)).toEqual([]);
    store.transaction(() =>
      store.saveContext(session.id, [{ role: "user", content: "committed" }]),
    );

    expect(store.context(session.id)[0].content).toBe("committed");
  } finally {
    store.close();
  }
});

it("reads large persisted JSON through a worker without changing its data", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "db"));

  try {
    const session = store.create(root, "large");
    const task = store.createTask(session.id);
    const content = "x".repeat(70 * 1024);
    store.event(session.id, task.id, "tool_result", { content });
    store.saveContext(session.id, [{ role: "user", content }]);

    await expect(store.eventsAsync(session.id)).resolves.toMatchObject([
      { data: { content } },
    ]);
    await expect(store.contextAsync(session.id)).resolves.toEqual([
      { role: "user", content },
    ]);
  } finally {
    store.close();
  }
});

it("persists captured replay exchanges and exports legacy cases without changing active tasks", async () => {
  const root = await temp();
  const file = path.join(root, "db");
  let store = new Store(file);
  const session = store.create(root, "replay");
  const captured = store.createTask(session.id);
  const legacy = store.createTask(session.id);

  try {
    store.startReplayCapture(captured, {
      schemaVersion: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      platform: "win32",
      settings: {
        model: "test",
        maxSteps: 1,
        commandTimeoutMs: 1,
        requestTimeoutMs: 1,
        idleTimeoutMs: 1,
        contextChars: 1,
        outputChars: 1,
      },
    });
    store.startReplayModelExchange(captured.id, {
      id: "model",
      purpose: "task",
      input: [],
      instructions: "rules",
      tools: [],
    });
    store.finishReplayModelExchange(captured.id, "model", {
      response: { output: [], text: "done" },
    });
    store.startReplayTool(captured.id, {
      callId: "read",
      nodeId: "read",
      batchId: "batch",
      name: "read_file",
      arguments: { path: "file.txt", startLine: 1 },
      dependsOn: [],
    });
    store.finishReplayTool(captured.id, "read", { text: "1: source" });
    store.status(captured.id, "completed");
    store.finishReplayCapture(captured.id, "completed");
    store.event(session.id, legacy.id, "tool_start", {
      callId: "legacy-read",
      nodeId: "legacy-read",
      name: "read_file",
      args: { path: "legacy.txt", startLine: 1 },
    });
    store.event(session.id, legacy.id, "tool_result", {
      callId: "legacy-read",
      result: { text: "1: source" },
    });

    expect(store.replayCase(captured.id)).toMatchObject({
      source: "captured",
      capture: {
        finalizedAt: expect.any(String),
        modelExchanges: [{ response: { text: "done" } }],
        tools: [{ result: { text: "1: source" } }],
      },
    });
    expect(store.replayCase(legacy.id)).toMatchObject({
      source: "legacy",
      tools: [{ callId: "legacy-read", result: { text: "1: source" } }],
    });

    store.close();
    store = new Store(file, { interruptActive: false });
    expect(store.task(legacy.id)?.status).toBe("queued");
  } finally {
    store.close();
  }
});

it("restart interrupts active tasks but preserves terminal states and context", async () => {
  const root = await temp();
  const file = path.join(root, "db");
  let store = new Store(file);
  const session = store.create(root, "s");

  for (const status of [
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    const task = store.createTask(session.id);

    store.status(task.id, status);
  }

  store.saveContext(session.id, [{ role: "user", content: "saved" }]);
  store.close();
  store = new Store(file);
  try {
    expect(store.tasks(session.id).map((t) => t.status)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(store.context(session.id)[0].content).toBe("saved");
  } finally {
    store.close();
  }
});

it("persists task-level subagent selection and migrates legacy shards without enabling it", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  let store = new Store(file, { maxShardBytes: 1 });
  const legacySession = store.create(root, "legacy");
  const legacyTask = store.createTask(legacySession.id);
  const currentSession = store.create(root, "current");
  const selected = store.createTask(currentSession.id, true);

  expect(store.task(selected.id)?.subagentsEnabled).toBe(true);
  expect(
    store.queuedTasks().find((task) => task.id === selected.id)
      ?.subagentsEnabled,
  ).toBe(true);
  store.close();

  // CREATE TABLE IF NOT EXISTS 不会为旧分片补列；迁移必须逐文件执行。
  const oldDb = new DatabaseSync(file);
  oldDb.exec("ALTER TABLE tasks DROP COLUMN subagentsEnabled");
  oldDb.close();

  store = new Store(file, { maxShardBytes: 1, interruptActive: false });
  try {
    expect(store.task(legacyTask.id)?.subagentsEnabled).toBe(false);
    expect(store.tasks(legacySession.id)[0].subagentsEnabled).toBe(false);
    expect(store.tasks(currentSession.id)[0].subagentsEnabled).toBe(true);
    expect(
      store.queuedTasks().find((task) => task.id === selected.id)
        ?.subagentsEnabled,
    ).toBe(true);
  } finally {
    store.close();
  }
});

it("rotates new sessions into a later history shard while preserving old worker reads", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  const maxShardBytes = 64 * 1024;
  let store = new Store(file, { maxShardBytes });

  try {
    const first = store.create(root, "first");
    const firstTask = store.createTask(first.id);
    const content = "x".repeat(80 * 1024);
    store.event(first.id, firstTask.id, "tool_result", { content });
    store.saveContext(first.id, [{ role: "user", content }]);

    const second = store.create(root, "second");
    expect(readdirSync(root)).toContain("history-000001.sqlite");
    expect(store.events(first.id)).toMatchObject([{ data: { content } }]);
    await expect(store.contextAsync(first.id)).resolves.toEqual([
      { role: "user", content },
    ]);
    expect(store.list().map((session) => session.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );

    store.close();
    store = new Store(file, { interruptActive: false, maxShardBytes });
    expect(store.get(first.id)?.title).toBe("first");
    expect(store.get(second.id)?.title).toBe("second");
    await expect(store.contextAsync(first.id)).resolves.toEqual([
      { role: "user", content },
    ]);
  } finally {
    store.close();
  }
});
