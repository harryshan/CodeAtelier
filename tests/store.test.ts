/**
 * 在临时 SQLite 文件上检查 Store 的数据隔离、事务回滚和重启行为。
 * 通过关闭后重新创建 Store 验证磁盘记录，不使用数据库替身。
 *
 * 1. 创建两个会话，核对各自事件、读取游标和上下文。
 * 2. 后续分片取锁失败时释放已取得的事务；在保存任务和事件的事务中制造失败，确认整笔事务回滚。
 * 3. 保存排队、运行和终态任务后重启，确认所有未完成任务变为 interrupted。
 * 4. 大于同步阈值的事件和上下文由 Worker 读取，验证结果与同步接口相同且数据库可正常关闭。
 * 5. 增量保存 replay 模型/工具并校验真实存储前缀、Worker 路径、重启与旧整条捕获兼容。
 * 6. 以小容量阈值触发新会话分片，确认旧分片的上下文仍可由 Worker 读取，并在重启后发现全部分片。
 * 7. 任务级 subagent 选择写入队列后保持布尔类型；模拟旧表缺列并检查跨分片迁移默认关闭。
 * 8. 子任务计划、检查点、问题与请求回执真实落盘；重启保留已确认问题和未知模型请求，迟到报告不误标消费。
 * 9. 增量上下文跨重启重建；旧分片先备份再迁移，备份失败保持原状。
 *
 * 重启要保留已有终态和上下文，不能把其他会话的数据混进来。
 */

import { it, expect } from "vitest";
import { readdirSync, writeFileSync } from "node:fs";
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

it("appends context batches and rolls back event plus feedback together", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));
  try {
    const session = store.create(root);
    const task = store.createTask(session.id);
    const first = { role: "user", content: "before" };
    const feedback = {
      type: "function_call_output",
      call_id: "read",
      output: "ok",
    };
    store.saveContext(session.id, [first]);
    store.appendContext(session.id, [feedback]);
    store.appendContext(session.id, []);

    expect(
      store.db
        .prepare(
          "SELECT position,items FROM context_chunks WHERE sessionId=? ORDER BY position",
        )
        .all(session.id),
    ).toEqual([
      { position: 0, items: JSON.stringify([first]) },
      { position: 1, items: JSON.stringify([feedback]) },
    ]);
    expect(store.context(session.id)).toEqual([first, feedback]);
    await expect(store.contextAsync(session.id)).resolves.toEqual([
      first,
      feedback,
    ]);

    expect(() =>
      store.transaction(() => {
        store.event(session.id, task.id, "tool_result", { callId: "failed" });
        store.appendContext(session.id, [
          { type: "function_call_output", call_id: "failed", output: "x" },
        ]);
        throw new Error("write aborted");
      }),
    ).toThrow("write aborted");
    expect(store.context(session.id)).toEqual([first, feedback]);
    expect(store.events(session.id)).toEqual([]);
  } finally {
    store.close();
  }
});

it("backs up every legacy shard before migrating its context", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  let store = new Store(file, { maxShardBytes: 1 });
  const first = store.create(root);
  const second = store.create(root);
  store.close();

  for (const [shard, session, text] of [
    [file, first.id, "old-one"],
    [path.join(root, "history-000001.sqlite"), second.id, "old-two"],
  ] as const) {
    const db = new DatabaseSync(shard);
    db.prepare("INSERT INTO context(sessionId,items) VALUES(?,?)").run(
      session,
      JSON.stringify([{ role: "user", content: text }]),
    );
    db.exec("DROP TABLE context_chunks; PRAGMA user_version = 7");
    db.close();
  }

  store = new Store(file, { maxShardBytes: 1, interruptActive: false });
  try {
    expect(store.context(first.id)).toEqual([
      { role: "user", content: "old-one" },
    ]);
    expect(store.context(second.id)).toEqual([
      { role: "user", content: "old-two" },
    ]);
    store.appendContext(first.id, [{ role: "assistant", content: "new" }]);
    expect(store.context(first.id)).toHaveLength(2);
    const backups = readdirSync(path.join(root, "backups"));
    expect(backups).toHaveLength(2);
    for (const backup of backups) {
      const db = new DatabaseSync(path.join(root, "backups", backup));
      expect(db.prepare("SELECT items FROM context").all()).toHaveLength(1);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 7,
      });
      db.close();
    }
  } finally {
    store.close();
  }

  store = new Store(file, { maxShardBytes: 1, interruptActive: false });
  expect(store.context(first.id)).toHaveLength(2);
  expect(readdirSync(path.join(root, "backups"))).toHaveLength(2);
  store.close();
});

it("refuses migration when the legacy backup cannot be created", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  const store = new Store(file);
  const session = store.create(root);
  store.close();
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO context(sessionId,items) VALUES(?,?)").run(
    session.id,
    JSON.stringify([{ role: "user", content: "safe" }]),
  );
  db.exec("PRAGMA user_version = 7");
  db.close();
  writeFileSync(path.join(root, "backups"), "block directory creation");

  expect(() => new Store(file)).toThrow();
  const untouched = new DatabaseSync(file);
  expect(untouched.prepare("SELECT items FROM context").get()).toEqual({
    items: JSON.stringify([{ role: "user", content: "safe" }]),
  });
  untouched.close();
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

it("serializes regular writes on the Store worker and reads only committed results", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  const store = new Store(file);

  try {
    const session = await store.createAsync(root, "worker writes");
    const { task, events } = await store.startTaskAsync(
      session.id,
      "first prompt",
      false,
    );
    expect(events.map((event) => event.type)).toEqual(["user"]);

    const first = store.eventAsync(session.id, task.id, "notice", { order: 1 });
    const second = store.appendContextAsync(
      session.id,
      [{ role: "user", content: "first" }],
      task.id,
    );
    const third = store.eventAsync(session.id, task.id, "notice", { order: 2 });
    await Promise.all([first, second, third]);
    expect(
      (await store.eventsAsync(session.id)).map((event) => event.type),
    ).toEqual(["user", "notice", "notice"]);
    expect(await store.contextAsync(session.id)).toEqual([
      { role: "user", content: "first" },
    ]);

    await store.replayAsync(task.id, "create", null, { schemaVersion: 1 });
    const feedback = {
      type: "function_call_output",
      call_id: "call-1",
      output: "ok",
    };
    const result = await store.persistToolResultAsync(
      session.id,
      task.id,
      { callId: "call-1" },
      feedback,
      "call-1",
      { ok: true },
    );
    expect(result.id).toBeGreaterThan((await first).id);
    expect((await store.eventsAsync(session.id)).at(-1)?.type).toBe(
      "tool_result",
    );
    expect((await store.contextAsync(session.id)).at(-1)).toEqual(feedback);
    await store.statusAsync(task.id, "completed");
    expect(store.task(task.id)?.status).toBe("completed");
  } finally {
    await store.closeAsync();
  }

  const reopened = new Store(file, { interruptActive: false });
  try {
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.tasks(reopened.list()[0].id)[0]?.status).toBe("completed");
  } finally {
    reopened.close();
  }
});

it("rolls back a worker batch when context serialization fails", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));
  try {
    const session = await store.createAsync(root);
    const task = store.createTask(session.id);
    await expect(
      store.persistToolResultAsync(
        session.id,
        task.id,
        { content: "x" },
        { type: "function_call_output", output: 1n },
        "call-1",
        { content: "x" },
      ),
    ).rejects.toThrow();
    expect(await store.eventsAsync(session.id)).toEqual([]);
    expect(await store.contextAsync(session.id)).toEqual([]);
    const result = await store.eventAsync(session.id, task.id, "notice", {
      safe: true,
    });
    expect(result.data).toEqual({ safe: true });
  } finally {
    await store.closeAsync();
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

it("stores replay entries incrementally and rebuilds requests after restart", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  let store = new Store(file);
  const session = store.create(root);
  const task = store.createTask(session.id);
  const common = { role: "user", content: "large shared prompt".repeat(100) };
  const first = { role: "assistant", content: "one" };
  const changed = { role: "assistant", content: "two" };
  const metadata = {
    schemaVersion: 1,
    capturedAt: "2026-01-01T00:00:00.000Z",
    platform: "win32",
    settings: { model: "test" },
  };

  try {
    await store.replayAsync(task.id, "create", null, metadata);
    await store.replayAsync(task.id, "modelStart", null, {
      id: "first",
      purpose: "task",
      input: [common, first],
      instructions: "rules",
      tools: [],
    });
    await store.replayAsync(task.id, "modelFinish", "first", {
      response: { output: [], text: "ok" },
    });
    await store.replayAsync(task.id, "toolStart", null, {
      callId: "read",
      nodeId: "read",
      name: "read_file",
      batchId: "batch",
      arguments: { path: "test.txt" },
      dependsOn: [],
    });
    await store.replayAsync(task.id, "toolFinish", "read", { text: "data" });
    await store.replayAsync(task.id, "modelStart", null, {
      id: "second",
      purpose: "task",
      input: [common, changed],
      instructions: "rules",
      tools: [],
    });

    const rows = store.db
      .prepare(
        "SELECT kind,data FROM replay_entries WHERE taskId=? ORDER BY seq",
      )
      .all(task.id) as Array<{ kind: string; data: string }>;
    expect(rows.map((row) => row.kind)).toEqual(["model", "tool", "model"]);
    expect(JSON.parse(rows[0].data)).toMatchObject({
      inputPrefix: 0,
      inputSuffix: [common, first],
      response: { text: "ok" },
    });
    expect(JSON.parse(rows[2].data)).toMatchObject({
      inputPrefix: 1,
      inputSuffix: [changed],
    });
    expect(rows[2].data).not.toContain("large shared prompt");
    expect(
      JSON.parse(
        String(
          store.db
            .prepare("SELECT data FROM task_replays WHERE taskId=?")
            .get(task.id)?.data,
        ),
      ),
    ).toMatchObject({
      storageVersion: 2,
      settings: metadata.settings,
    });
    expect(store.replayCase(task.id)?.capture?.modelExchanges[1]).toMatchObject(
      {
        input: [common, changed],
      },
    );
    expect(
      store.replayCase(task.id)?.capture?.modelExchanges[1],
    ).not.toHaveProperty("response");

    await store.closeAsync();
    store = new Store(file, { interruptActive: false });
    await store.replayAsync(task.id, "modelStart", null, {
      id: "third",
      purpose: "task",
      input: [common, changed, { role: "assistant", content: "three" }],
      instructions: "rules",
      tools: [],
    });
    await store.replayAsync(task.id, "finish", null, "interrupted");
    expect(store.replayCase(task.id)?.capture).toMatchObject({
      status: "interrupted",
      modelExchanges: [
        { input: [common, first], response: { text: "ok" } },
        { input: [common, changed] },
        { input: [common, changed, { role: "assistant", content: "three" }] },
      ],
      tools: [{ result: { text: "data" } }],
    });
    expect(
      JSON.parse(
        String(
          store.db
            .prepare(
              "SELECT data FROM replay_entries WHERE taskId=? AND itemId='third'",
            )
            .get(task.id)?.data,
        ),
      ).inputPrefix,
    ).toBe(2);
    await expect(
      store.replayAsync(task.id, "modelFinish", "missing", {
        error: { name: "Error", message: "no start" },
      }),
    ).rejects.toThrow("缺少对应的开始记录");
    expect(store.replayCase(task.id)?.capture?.modelExchanges).toHaveLength(3);
  } finally {
    await store.closeAsync();
  }
});

it("upgrades a v8 replay database without rewriting captured JSON", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  let store = new Store(file);
  const session = store.create(root);
  const task = store.createTask(session.id);
  const oldCapture = {
    schemaVersion: 1,
    capturedAt: "2026-01-01T00:00:00.000Z",
    platform: "win32",
    settings: { model: "old" },
    modelExchanges: [
      {
        id: "old",
        purpose: "task",
        input: [{ role: "user", content: "original" }],
        instructions: "rules",
        tools: [],
        response: { output: [], text: "ok" },
      },
    ],
    tools: [],
    status: "completed",
  };
  store.db
    .prepare("INSERT INTO task_replays(taskId,data) VALUES(?,?)")
    .run(task.id, JSON.stringify(oldCapture));
  store.close();
  const oldDb = new DatabaseSync(file);
  oldDb.exec("DROP TABLE replay_entries; PRAGMA user_version = 8");
  oldDb.close();

  store = new Store(file, { interruptActive: false });
  try {
    expect(store.replayCase(task.id)?.capture).toEqual(oldCapture);
    expect(store.replayCase(task.id)?.source).toBe("captured");
    const backup = readdirSync(path.join(root, "backups"));
    expect(backup).toHaveLength(1);
    const db = new DatabaseSync(path.join(root, "backups", backup[0]));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 8,
    });
    expect(db.prepare("SELECT data FROM task_replays").get()).toEqual({
      data: JSON.stringify(oldCapture),
    });
    db.close();
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

  store.event(session.id, store.tasks(session.id)[0].id, "user", {
    text: "hello",
  });
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
    expect(store.events(session.id).at(-1)).toMatchObject({
      type: "user",
      data: { text: "hello" },
    });
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

it("persists subagent plans and checkpoints while keeping interrupted requests unknown", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  let store = new Store(file);
  const session = store.create(root, "agents");
  const task = store.createTask(session.id, true);
  store.status(task.id, "running");
  const plan = {
    id: "reviewer",
    role: "审查者",
    objective: "找调用方",
    scope: ["src"],
    dependsOn: [],
    deliverable: "结论",
  };

  try {
    expect(store.planSubagents(task.id, [plan])).toMatchObject([
      { id: "reviewer", status: "planned", consumed: false },
    ]);
    expect(() => store.planSubagents(task.id, [plan])).toThrow("重复");
    expect(store.subagents(task.id)).toHaveLength(1);
    store.updateSubagent(task.id, "reviewer", "running", [
      { role: "user", content: "read" },
    ]);
    store.startSubagentRequest(task.id, "reviewer", "model-1", "model");
    expect(() =>
      store.startSubagentRequest(task.id, "reviewer", "model-1", "model"),
    ).toThrow();
    store.startSubagentRequest(task.id, "reviewer", "read-1", "read_file");
    store.finishSubagentRequest(task.id, "reviewer", "read-1", {
      path: "src/a.ts",
    });
    store.close();

    store = new Store(file);
    expect(store.subagents(task.id)).toMatchObject([
      {
        id: "reviewer",
        status: "interrupted",
        context: [{ role: "user", content: "read" }],
      },
    ]);
    expect(store.subagentRequest(task.id, "reviewer", "model-1")).toMatchObject(
      { status: "unknown" },
    );
    expect(store.subagentRequest(task.id, "reviewer", "read-1")).toMatchObject({
      status: "completed",
      result: { path: "src/a.ts" },
    });
    expect(() =>
      store.planSubagents(task.id, [{ ...plan, id: "next" }]),
    ).toThrow("尚未运行");
  } finally {
    store.close();
  }
});

it("persists one bounded subagent question and returns its recorded receipt without replay", async () => {
  const root = await temp();
  const file = path.join(root, "history.sqlite");
  let store = new Store(file);
  const session = store.create(root);
  const task = store.createTask(session.id, true);
  store.status(task.id, "running");
  store.planSubagents(task.id, [
    {
      id: "reader",
      role: "researcher",
      objective: "inspect",
      scope: ["."],
      dependsOn: [],
      deliverable: "evidence",
    },
  ]);
  store.updateSubagent(task.id, "reader", "running", []);

  try {
    const receipt = store.recordSubagentQuestion(
      task.id,
      "reader",
      "ask-1",
      "Which file owns this?",
    );
    expect(receipt).toMatchObject({
      id: expect.any(Number),
      subagentId: "reader",
    });
    expect(
      store.recordSubagentQuestion(
        task.id,
        "reader",
        "ask-1",
        "Which file owns this?",
      ),
    ).toEqual(receipt);
    expect(() =>
      store.recordSubagentQuestion(
        task.id,
        "reader",
        "ask-1",
        "Changed question",
      ),
    ).toThrow();
    expect(() =>
      store.recordSubagentQuestion(task.id, "other", "ask-2", "Forged child"),
    ).toThrow();
    expect(
      store
        .events(session.id)
        .filter((event) => event.type === "subagent_question"),
    ).toHaveLength(1);
    store.close();

    store = new Store(file);
    expect(store.subagentRequest(task.id, "reader", "ask-1")).toMatchObject({
      status: "completed",
      result: receipt,
    });
    expect(
      store
        .events(session.id)
        .filter((event) => event.type === "subagent_question"),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});

it("commits a finished subagent report with main feedback and keeps it readable", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));
  try {
    const session = store.create(root);
    const task = store.createTask(session.id, true);
    store.status(task.id, "running");
    store.planSubagents(task.id, [
      {
        id: "check",
        role: "reviewer",
        objective: "read",
        scope: ["."],
        dependsOn: [],
        deliverable: "report",
      },
    ]);

    expect(store.collectSubagents(task.id, ["check"])).toMatchObject([
      { status: "planned", report: null, consumed: false },
    ]);
    store.updateSubagent(task.id, "check", "completed", [], "evidence");
    expect(store.collectSubagents(task.id, ["check"])).toMatchObject([
      { status: "completed", report: "evidence", consumed: false },
    ]);
    store.commitSubagentCollect(
      task.id,
      ["check"],
      () => {
        store.event(session.id, task.id, "tool_result", { report: "evidence" });
        store.saveContext(session.id, [
          { type: "function_call_output", output: "evidence" },
        ]);
      },
      store.collectSubagents(task.id, ["check"]),
    );
    expect(store.subagents(task.id)[0].consumed).toBe(true);
    expect(store.collectSubagents(task.id, ["check"])).toMatchObject([
      { status: "completed", report: "evidence", consumed: true },
    ]);
    expect(() => store.collectSubagents(task.id, ["other"])).toThrow(
      "另一任务",
    );
  } finally {
    store.close();
  }
});

it("leaves subagent reports available until main tool feedback commits atomically", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));

  try {
    const session = store.create(root);
    const task = store.createTask(session.id, true);
    store.status(task.id, "running");
    store.planSubagents(task.id, [
      {
        id: "check",
        role: "reviewer",
        objective: "read",
        scope: ["."],
        dependsOn: [],
        deliverable: "report",
      },
    ]);
    store.updateSubagent(task.id, "check", "completed", [], "evidence");

    expect(store.collectSubagents(task.id, ["check"])).toMatchObject([
      { report: "evidence", consumed: false },
    ]);
    expect(store.subagents(task.id)[0].consumed).toBe(false);
    expect(() =>
      store.commitSubagentCollect(
        task.id,
        ["check"],
        () => {
          store.event(session.id, task.id, "tool_result", {
            report: "evidence",
          });
          throw new Error("simulated main context failure");
        },
        store.collectSubagents(task.id, ["check"]),
      ),
    ).toThrow("simulated main context failure");
    expect(store.subagents(task.id)[0].consumed).toBe(false);
    expect(
      store.events(session.id).filter((event) => event.type === "tool_result"),
    ).toEqual([]);
  } finally {
    store.close();
  }
});

it("does not consume a report that completed after the delivered preview", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));

  try {
    const session = store.create(root);
    const task = store.createTask(session.id, true);
    store.status(task.id, "running");
    store.planSubagents(task.id, [
      {
        id: "late",
        role: "reviewer",
        objective: "inspect",
        scope: ["."],
        dependsOn: [],
        deliverable: "evidence",
      },
    ]);
    const delivered = store.collectSubagents(task.id, ["late"]);
    expect(delivered).toMatchObject([{ status: "planned", report: null }]);

    store.updateSubagent(task.id, "late", "completed", [], "late evidence");
    store.commitSubagentCollect(
      task.id,
      ["late"],
      () => {
        store.event(session.id, task.id, "tool_result", { reports: delivered });
        store.saveContext(session.id, [
          {
            type: "function_call_output",
            output: JSON.stringify({ reports: delivered }),
          },
        ]);
      },
      delivered,
    );
    expect(store.subagents(task.id)).toMatchObject([
      { id: "late", consumed: false },
    ]);
    expect(store.collectSubagents(task.id, ["late"])).toMatchObject([
      { status: "completed", report: "late evidence", consumed: false },
    ]);
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
