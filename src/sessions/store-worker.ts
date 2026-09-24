/**
 * 在独立 Worker 线程中读取或写入较大的 SQLite JSON 字段，避免历史快照、上下文和事件的解析/序列化占用 HTTP 主线程。
 * Store 通过 worker_threads 一次性启动本模块；输入是数据库路径和受限 operation，输出是已解析的只读数据或完成信号。
 *
 * 1. readContext 顺序拼接基线与增量；其他读取从数据库加载大 JSON，仅在本线程解析。
 * 2. compact 在本线程 JSON.stringify 压缩前快照和活动上下文，并用与 Store 相同的 BEGIN IMMEDIATE 事务原子写入两张表。
 * 3. 主线程只接收结构化克隆结果；Worker 不处理权限、模型、文件或用户输入，也不会执行任意 SQL。
 *
 * 每次请求单独打开 SQLite 连接，WAL 允许它与主 Store 的短查询共存。事务失败会回滚，不能撤销已经发生的文件或模型副作用。
 */

import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

interface Request {
  operation: "context" | "events" | "latestSnapshot" | "snapshot" | "compact";
  file: string;
  sessionId: string;
  snapshotId?: string;
  after?: number;
  snapshot?: unknown;
  input?: unknown;
}

function handle(request: Request) {
  const db = new DatabaseSync(request.file);

  try {
    if (request.operation === "context") {
      const rows = db
        .prepare(
          "SELECT items FROM context_chunks WHERE sessionId=? ORDER BY position",
        )
        .all(request.sessionId) as Array<{ items: string }>;

      return rows.flatMap((row) => JSON.parse(row.items) as unknown[]);
    }

    if (request.operation === "events") {
      return db
        .prepare("SELECT * FROM events WHERE sessionId=? AND id>? ORDER BY id")
        .all(request.sessionId, request.after || 0)
        .map((row: any) => ({ ...row, data: JSON.parse(String(row.data)) }));
    }

    if (request.operation === "latestSnapshot") {
      const row = db
        .prepare(
          "SELECT data FROM context_snapshots WHERE sessionId=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(request.sessionId) as { data: string } | undefined;

      return row ? JSON.parse(row.data) : undefined;
    }

    if (request.operation === "snapshot") {
      if (!request.snapshotId) {
        throw new Error("快照读取请求缺少 ID。");
      }

      const row = db
        .prepare(
          "SELECT data FROM context_snapshots WHERE sessionId=? AND id=?",
        )
        .get(request.sessionId, request.snapshotId) as
        { data: string } | undefined;

      return row ? JSON.parse(row.data) : undefined;
    }

    if (request.operation === "compact") {
      if (request.snapshot === undefined || request.input === undefined) {
        throw new Error("压缩存储请求缺少快照或活动上下文。");
      }

      const snapshot = JSON.stringify(request.snapshot);
      const input = JSON.stringify(request.input);
      const snapshotId = (request.snapshot as { id?: unknown }).id;
      if (typeof snapshotId !== "string") {
        throw new Error("压缩快照缺少 ID。");
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO context_snapshots(id,sessionId,data) VALUES(?,?,?)",
        ).run(snapshotId, request.sessionId, snapshot);
        db.prepare("DELETE FROM context_chunks WHERE sessionId=?").run(
          request.sessionId,
        );
        db.prepare(
          "INSERT INTO context_chunks(sessionId,position,items) VALUES(?,0,?)",
        ).run(request.sessionId, input);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return undefined;
    }

    throw new Error("未知的 Store Worker 操作。");
  } finally {
    db.close();
  }
}

parentPort?.once("message", (request: Request) => {
  try {
    parentPort?.postMessage({ ok: true, value: handle(request) });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "Store Worker 执行失败。",
    });
  }
});
