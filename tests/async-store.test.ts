/**
 * 验证生产异步 Store 的提交和关闭边界，使用独立临时目录，不访问个人历史。
 * 1. 并发提交同会话任务只能成功一次，读者在提交回执后看到完整记录。
 * 2. 关闭排空已接受工作，关闭后的业务请求明确拒绝。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AsyncStore } from "../src/sessions/async-store.js";

test("worker commits are fenced for readers and close drains accepted work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "async-store-"));
  const store = await AsyncStore.open(path.join(directory, "history.sqlite"));
  try {
    const session = await store.createAsync(directory);
    const results = await Promise.allSettled([
      store.startTaskAsync(session.id, "first", false),
      store.startTaskAsync(session.id, "second", false),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const tasks = await store.tasks(session.id);
    expect(tasks).toHaveLength(1);
    expect(await store.eventsAsync(session.id)).toHaveLength(1);
    const saved = store.eventAsync(session.id, tasks[0]!.id, "notice", {
      text: "saved",
    });
    await store.closeAsync();
    await expect(saved).resolves.toMatchObject({ type: "notice" });
    const wal = path.join(directory, "history.sqlite-wal");
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
    await expect(store.list()).rejects.toThrow();
  } finally {
    await store.closeAsync();
    await rm(directory, { recursive: true, force: true });
  }
});
