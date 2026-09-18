/**
 * 在临时 SQLite 文件上检查 Store 的数据隔离、事务回滚和重启行为。
 * 通过关闭后重新创建 Store 验证磁盘记录，不使用数据库替身。
 *
 * 1. 创建两个会话，核对各自事件、读取游标和上下文。
 * 2. 在保存任务和事件的事务中制造失败，确认整笔事务回滚。
 * 3. 保存排队、运行和终态任务后重启，确认所有未完成任务变为 interrupted。
 * 4. 大于同步阈值的事件和上下文由 Worker 读取，验证结果与同步接口相同且数据库可正常关闭。
 * 5. 逐步保存 replay 模型/工具捕获并导出单任务 case；旧事件只能形成明确的 legacy case。
 *
 * 重启要保留已有终态和上下文，不能把其他会话的数据混进来。
 */

import { it, expect } from "vitest";
import path from "node:path";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

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
