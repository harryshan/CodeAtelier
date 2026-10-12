/**
 * 离线 generation 的故障注入测试，使用最小旧版合成库，不访问用户数据。
 * 1. 未验证目标禁止启动，转换后逐片验证与整体激活保留原件并阻断旧默认入口。
 * 2. 文件移动中断后按日志续跑，不重新转换或重放任务。
 * 3. 已发生业务写入的 generation 拒绝重新激活或隐式回退。
 */
import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { temp } from "./fixtures/helpers.js";
import { AsyncStore } from "../src/sessions/async-store.js";
import {
  activateGeneration,
  captureFiles,
  convertGeneration,
  verifyGeneration,
} from "../src/sessions/history-generation.js";

test("activation resumes after a move and preserves originals", async () => {
  const directory = await temp();
  const source = path.join(directory, "source");
  const snapshots = path.join(directory, "snapshot");
  const target = path.join(directory, "generation");
  mkdirSync(source);
  mkdirSync(snapshots);
  const file = path.join(source, "history.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,workspace TEXT,createdAt TEXT,updatedAt TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,sessionId TEXT,status TEXT,createdAt TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT,taskId TEXT,type TEXT,data TEXT,createdAt TEXT); PRAGMA user_version=1;",
  );
  db.prepare(
    "INSERT INTO sessions VALUES('s','title',?,'2026-01-01','2026-01-01')",
  ).run(directory);
  db.close();
  copyFileSync(file, path.join(snapshots, "history.sqlite"));
  const originals = captureFiles(source);
  convertGeneration(snapshots, target);
  await expect(
    AsyncStore.open(path.join(target, "history.sqlite")),
  ).rejects.toThrow();
  // Read-only WAL-mode connections can leave an empty WAL and a shared-memory index.
  writeFileSync(
    path.join(snapshots, "history.sqlite-shm"),
    Buffer.alloc(32768),
  );
  writeFileSync(path.join(snapshots, "history.sqlite-wal"), Buffer.alloc(0));
  verifyGeneration(snapshots, target);
  expect(() =>
    activateGeneration(source, target, originals, () => {
      throw new Error("injected");
    }),
  ).toThrow("injected");
  await expect(AsyncStore.open(file)).rejects.toThrow();
  activateGeneration(source, target, originals);
  expect(statSync(file).isDirectory()).toBe(true);
  const store = await AsyncStore.open(file);
  expect(await store.get("s")).toMatchObject({ title: "title" });
  await store.closeAsync();
  expect(existsSync(path.join(target, "business-started"))).toBe(true);
  expect(() => activateGeneration(source, target, originals)).toThrow();
});
