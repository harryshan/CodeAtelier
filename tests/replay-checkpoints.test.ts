/**
 * 在内存 SQLite 中验证目标 Replay 编码的完整性与随机读取边界。
 * schema 与 replay-storage 是真实实现，不使用模型、用户数据或文件系统。
 *
 * 1. 交替追加和替换输入，核对完整重建并要求定期保存检查点。
 * 2. 请求终态独立保存，结束响应不得重写请求材料。
 * 3. 未完成请求必须保持缺少终态，不伪造响应或失败。
 */
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/sessions/schema.js";
import {
  readReplayCapture,
  writeReplay,
} from "../src/sessions/replay-storage.js";
import type { RecordedModelExchange } from "../src/sessions/replay-case.js";

it("checkpoints changing inputs and keeps request material immutable at finish", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(
    "INSERT INTO sessions(id,title,workspace,createdAt,updatedAt) VALUES('s','s','workspace','date','date')",
  );
  db.exec(
    "INSERT INTO tasks(id,sessionId,status,createdAt) VALUES('t','s','running','date')",
  );
  try {
    writeReplay(db, "t", "create", null, {
      schemaVersion: 1,
      capturedAt: "date",
      platform: "test",
      settings: {},
    });
    const expected: RecordedModelExchange[] = [];
    for (let index = 0; index < 70; index++) {
      const entry: RecordedModelExchange = {
        id: `request-${index}`,
        purpose: "task",
        input: [
          { role: "user", content: "原始\r\n文本" },
          { role: "user", content: String(index) },
        ],
        instructions: "rules",
        tools: [],
      };
      writeReplay(db, "t", "modelStart", null, entry);
      expected.push(entry);
    }

    const before = db
      .prepare("SELECT data FROM replay_entries WHERE itemId='request-69'")
      .get();
    writeReplay(db, "t", "modelFinish", "request-69", {
      response: { output: [], text: "done" },
    });
    expected[69]!.response = { output: [], text: "done" };

    expect(
      db
        .prepare("SELECT data FROM replay_entries WHERE itemId='request-69'")
        .get(),
    ).toEqual(before);
    expect(readReplayCapture(db, "t")?.modelExchanges).toEqual(expected);
    expect(
      JSON.parse(
        String(db.prepare("SELECT data FROM task_replays").get()!.data),
      ).storageVersion,
    ).toBe(3);
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM replay_entries WHERE checkpoint=1",
        )
        .get()!.count,
    ).toBeGreaterThanOrEqual(3);
    expect(readReplayCapture(db, "t")?.modelExchanges[0]).not.toHaveProperty(
      "response",
    );
  } finally {
    db.close();
  }
});
