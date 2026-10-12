/**
 * 空间治理的合成数据库回归，不接触用户历史，也不运行模型 Evaluation。
 * 1. 固定旧读视图使 WAL 不能完成 checkpoint，整理必须报告忙而非删除 WAL。
 * 2. 释放读者后整理保留全部提交行、回收空闲页，并维持 SQLite 完整性。
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect, test } from "vitest";
import { temp } from "./fixtures/helpers.js";
import {
  compactOffline,
  storageMetrics,
} from "../src/sessions/storage-maintenance.js";

test("pinned WAL blocks maintenance until the reader releases its snapshot", async () => {
  const file = path.join(await temp(), "history.sqlite");
  const writer = new DatabaseSync(file);
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(id INTEGER PRIMARY KEY,body TEXT); CREATE TABLE migration_identity(singleton INTEGER,state TEXT); INSERT INTO migration_identity VALUES(1,'verified');",
  );
  const insert = writer.prepare("INSERT INTO payload(body) VALUES(?)");
  writer.exec("BEGIN");
  for (let index = 0; index < 300; index++) {
    insert.run("x".repeat(16384));
  }

  writer.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    reader.exec("BEGIN");
    expect(reader.prepare("SELECT count(*) AS n FROM payload").get()!.n).toBe(
      300,
    );
    writer.exec("DELETE FROM payload WHERE id<=250");
    expect(storageMetrics(file).walBytes).toBeGreaterThan(0);
    expect(() => compactOffline(file)).toThrow("读写者");
    expect(reader.prepare("SELECT count(*) AS n FROM payload").get()!.n).toBe(
      300,
    );
    reader.exec("COMMIT");
    writer.close();
    const compacted = compactOffline(file);
    expect(compacted.freePages).toBe(0);
    expect(compacted.walBytes).toBe(0);
    expect(reader.prepare("SELECT count(*) AS n FROM payload").get()!.n).toBe(
      50,
    );
    expect(
      reader.prepare("PRAGMA integrity_check").get()!.integrity_check,
    ).toBe("ok");
    expect(
      reader.prepare("SELECT state FROM migration_identity").get()!.state,
    ).toBe("converted");
  } finally {
    reader.close();
    if (writer.isOpen) {
      writer.close();
    }
  }
});
