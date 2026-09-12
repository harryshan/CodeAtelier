/**
 * 文件作用：验证 SQLite 历史存储的隔离、事务和重启行为。
 * 代码结构：依次测试会话事件游标、失败时任务与事件一起回滚，以及重启仅中断未完成任务并保留上下文。
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

it("restart interrupts active tasks but preserves terminal states and context", async () => {
  const root = await temp();
  const file = path.join(root, "db");
  let store = new Store(file);
  const session = store.create(root, "s");

  for (const status of [
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
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(store.context(session.id)[0].content).toBe("saved");
  } finally {
    store.close();
  }
});
