/**
 * 用冻结的合成 v10 数据库验证离线转换；不读取用户历史或执行模型、工具。
 * 1. 夹具保留 rowid 空洞、同时间随机任务 ID、JSON 键顺序和未完成 Replay。
 * 2. 转换后检查所有正文、显式顺序、检查点和独立校验；VACUUM 不改变业务顺序。
 * 3. 注入已提交后回执丢失并续跑，确认进度与数据原子提交且不重复导入。
 * 4. 改变输入、未知扩展表和验证后的正文篡改均必须失败，原始源始终不变。
 */
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { temp } from "./fixtures/helpers.js";
import { migrateShard, verifyShard } from "../src/sessions/migration.js";
import { readReplayExchange } from "../src/sessions/replay-storage.js";

async function fixture() {
  const root = await temp();
  const source = path.join(root, "source.sqlite");
  const target = path.join(root, "target.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,workspace TEXT,createdAt TEXT,updatedAt TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,sessionId TEXT,status TEXT,createdAt TEXT,error TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY,sessionId TEXT,taskId TEXT,type TEXT,data TEXT,createdAt TEXT);
    CREATE TABLE context(sessionId TEXT PRIMARY KEY,items TEXT);
    CREATE TABLE context_snapshots(id TEXT PRIMARY KEY,sessionId TEXT,data TEXT);
    CREATE TABLE task_replays(taskId TEXT PRIMARY KEY,data TEXT);
    PRAGMA user_version=10;
    INSERT INTO sessions VALUES('s','原文','/workspace','same','same');
    INSERT INTO tasks(rowid,id,sessionId,status,createdAt) VALUES(3,'z','s','interrupted','same'),(19,'a','s','completed','same');
    INSERT INTO events VALUES(7,'s','z','tool_result','{"callId":"repeated","result":{"z":1,"a":2}}','same');
    INSERT INTO context VALUES('s','[{"z":"中文\\r\\n  ","a":1}]');
    INSERT INTO context_snapshots(rowid,id,sessionId,data) VALUES(4,'z','s','{"id":"z","sessionId":"s","parentId":null,"source":[]}'),(10,'a','s','{"id":"a","sessionId":"s","parentId":"z","source":[]}');
  `);
  const exchanges = Array.from({ length: 70 }, (_, index) => ({
    id: `model-${index}`,
    purpose: "task",
    input: [{ z: "中文\r\n  ", a: 1 }, { value: index }],
    instructions: " exact\r\n",
    tools: [],
    ...(index === 69 ? {} : { error: { name: "Test", message: "unknown" } }),
  }));
  db.prepare("INSERT INTO task_replays VALUES(?,?)").run(
    "z",
    JSON.stringify({
      schemaVersion: 1,
      capturedAt: "original",
      platform: "test",
      settings: {},
      extra: { z: true, a: null },
      modelExchanges: exchanges,
      tools: [
        {
          callId: "repeated",
          name: "unknown",
          arguments: { z: 1, a: 2 },
          dependsOn: [],
          nodeId: "n",
          batchId: "b",
        },
      ],
    }),
  );
  db.close();

  return { source, target, exchanges };
}

it("converts and independently verifies every record without changing frozen input", async () => {
  const { source, target, exchanges } = await fixture();
  const original = readFileSync(source);
  await migrateShard(source, target, { batchRows: 2 });
  const report = verifyShard(source, target);
  expect(report.replayEntries).toBe(71);
  const db = new DatabaseSync(target);
  db.exec("VACUUM");
  expect(
    db.prepare("SELECT id FROM tasks ORDER BY createdAt,orderKey").all(),
  ).toEqual([{ id: "z" }, { id: "a" }]);
  expect(
    db
      .prepare(
        "SELECT id FROM context_snapshots ORDER BY orderKey DESC LIMIT 1",
      )
      .get(),
  ).toEqual({ id: "a" });
  expect(db.prepare("SELECT items FROM context_chunks").get()?.items).toBe(
    '[{"z":"中文\\r\\n  ","a":1}]',
  );
  for (const exchange of exchanges) {
    expect(readReplayExchange(db, "z", exchange.id)).toEqual(exchange);
    expect(
      JSON.stringify(readReplayExchange(db, "z", exchange.id)?.input),
    ).toBe(JSON.stringify(exchange.input));
  }

  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM replay_entries WHERE checkpoint=1")
      .get()?.n,
  ).toBe(3);
  db.close();
  expect(readFileSync(source)).toEqual(original);
  expect(verifyShard(source, target).replayEntries).toBe(71);
});

it("resumes data committed before a lost acknowledgement and rejects changed input", async () => {
  const { source, target } = await fixture();
  await expect(
    migrateShard(source, target, {
      batchRows: 2,
      afterCommit(stage) {
        if (stage === "replay:z") {
          throw new Error("lost acknowledgement");
        }
      },
    }),
  ).rejects.toThrow("lost acknowledgement");
  await migrateShard(source, target, { batchRows: 2 });
  expect(verifyShard(source, target).replayEntries).toBe(71);
  const db = new DatabaseSync(source);
  db.prepare("UPDATE sessions SET title=?").run("changed");
  db.close();
  await expect(migrateShard(source, target)).rejects.toThrow("冻结输入");
});

it("fails on unknown source tables and on changed target body or record order", async () => {
  const { source, target } = await fixture();
  await migrateShard(source, target);
  const db = new DatabaseSync(target);
  db.prepare("UPDATE tasks SET orderKey=-orderKey").run();
  db.close();
  expect(() => verifyShard(source, target)).toThrow("顺序");
  const unknown = new DatabaseSync(source);
  unknown.exec("CREATE TABLE extension(secret TEXT)");
  unknown.close();
  await expect(
    migrateShard(source, path.join(path.dirname(target), "other.sqlite")),
  ).rejects.toThrow("未知源表");
});
