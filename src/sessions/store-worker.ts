/**
 * 在独立 Worker 线程中读取或写入较大的 SQLite JSON 字段，避免历史快照、上下文和事件的解析/序列化占用 HTTP 主线程。
 * Store 的串行队列复用本 Worker；输入是数据库路径和受限 operation，输出是已解析的数据或提交回执。
 *
 * 1. readContext 顺序拼接基线与增量；其他读取从数据库加载大 JSON，仅在本线程解析。
 * 2. compact 在本线程 JSON.stringify 压缩前快照和活动上下文，并用与 Store 相同的 BEGIN IMMEDIATE 事务原子写入快照/上下文并清除旧 token 锚点；显式替换也清除，普通追加不清除。
 * 3. replay 与同步 Store 共用增量编码；主线程只接收结构化克隆结果，Worker 不处理权限、模型、文件或用户输入，也不会执行任意 SQL。
 *
 * 每次请求单独打开 SQLite 连接，WAL 允许它与主 Store 的短查询共存。事务失败会回滚，不能撤销已经发生的文件或模型副作用。
 */

import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import { writeReplay } from "./replay-storage.js";

export interface StoreWorkerRequest {
  id: number;
  operation:
    | "context"
    | "tokenAnchor"
    | "events"
    | "latestSnapshot"
    | "snapshot"
    | "compact"
    | "write";
  file: string;
  sessionId: string;
  taskId?: string;
  snapshotId?: string;
  after?: number;
  snapshot?: unknown;
  input?: unknown;
  writes?: Array<{
    kind:
      | "event"
      | "context"
      | "contextReplace"
      | "tokenAnchor"
      | "status"
      | "replay"
      | "session"
      | "title"
      | "task";
    values: unknown[];
  }>;
}

export interface StoreWorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

function handle(request: StoreWorkerRequest) {
  const db = new DatabaseSync(request.file, { timeout: 5000 });
  db.exec("PRAGMA foreign_keys = ON");

  try {
    if (request.operation === "context") {
      const rows = db
        .prepare(
          "SELECT items FROM context_chunks WHERE sessionId=? ORDER BY position",
        )
        .all(request.sessionId) as Array<{ items: string }>;

      return rows.flatMap((row) => JSON.parse(row.items) as unknown[]);
    }

    if (request.operation === "tokenAnchor") {
      const row = db
        .prepare("SELECT data FROM context_token_anchors WHERE sessionId=?")
        .get(request.sessionId);

      return row ? JSON.parse(String(row.data)) : undefined;
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

    if (request.operation === "write") {
      if (!request.writes?.length) {
        throw new Error("Store 写入请求不能为空。");
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const write of request.writes) {
          if (write.kind === "event") {
            const [id, sessionId, taskId, type, data, createdAt] = write.values;
            db.prepare(
              "INSERT INTO events(id,sessionId,taskId,type,data,createdAt) VALUES(?,?,?,?,?,?)",
            ).run(
              id as number,
              sessionId as string,
              taskId as string,
              type as string,
              JSON.stringify(data),
              createdAt as string,
            );
            db.prepare("UPDATE sessions SET updatedAt=? WHERE id=?").run(
              createdAt as string,
              sessionId as string,
            );
          } else if (write.kind === "context") {
            const [sessionId, items] = write.values;
            db.prepare(
              "INSERT INTO context_chunks(sessionId,position,items) VALUES(?,(SELECT COALESCE(MAX(position)+1,0) FROM context_chunks WHERE sessionId=?),?)",
            ).run(
              sessionId as string,
              sessionId as string,
              JSON.stringify(items),
            );
          } else if (write.kind === "tokenAnchor") {
            const [sessionId, anchor] = write.values;
            db.prepare(
              "INSERT OR REPLACE INTO context_token_anchors(sessionId,data) VALUES(?,?)",
            ).run(sessionId as string, JSON.stringify(anchor));
          } else if (write.kind === "contextReplace") {
            const [sessionId, items] = write.values;
            db.prepare(
              "DELETE FROM context_token_anchors WHERE sessionId=?",
            ).run(sessionId as string);
            db.prepare("DELETE FROM context_chunks WHERE sessionId=?").run(
              sessionId as string,
            );
            db.prepare(
              "INSERT INTO context_chunks(sessionId,position,items) VALUES(?,0,?)",
            ).run(sessionId as string, JSON.stringify(items));
          } else if (write.kind === "status") {
            const [status, error, startedAt, finishedAt, taskId] = write.values;
            db.prepare(
              "UPDATE tasks SET status=?,error=?,startedAt=CASE WHEN ? IS NULL THEN startedAt ELSE COALESCE(startedAt,?) END,finishedAt=COALESCE(?,finishedAt) WHERE id=?",
            ).run(
              status as string,
              error as string | null,
              startedAt as string | null,
              startedAt as string | null,
              finishedAt as string | null,
              taskId as string,
            );
          } else if (write.kind === "session") {
            const [id, title, workspace, date, titleState] =
              write.values as string[];
            db.prepare(
              "INSERT INTO sessions(id,title,workspace,createdAt,updatedAt,titleState) VALUES(?,?,?,?,?,?)",
            ).run(id, title, workspace, date, date, titleState);
          } else if (write.kind === "task") {
            const [
              id,
              sessionId,
              date,
              subagentsEnabled,
              prompt,
              recovery,
              firstPrompt,
              userId,
              recoveryId,
            ] = write.values;
            if (
              db
                .prepare(
                  "SELECT 1 FROM tasks WHERE sessionId=? AND status IN ('queued','running','waiting') LIMIT 1",
                )
                .get(sessionId as string)
            ) {
              throw new Error(
                "当前会话已有运行中或排队中的任务，请等待或取消。",
              );
            }

            db.prepare(
              "INSERT INTO tasks(id,sessionId,status,createdAt,subagentsEnabled) VALUES(?,?,'queued',?,?)",
            ).run(
              id as string,
              sessionId as string,
              date as string,
              subagentsEnabled as number,
            );
            const event = db.prepare(
              "INSERT INTO events(id,sessionId,taskId,type,data,createdAt) VALUES(?,?,?,?,?,?)",
            );
            event.run(
              userId as number,
              sessionId as string,
              id as string,
              "user",
              JSON.stringify({ text: prompt }),
              date as string,
            );
            if (recovery) {
              event.run(
                recoveryId as number,
                sessionId as string,
                id as string,
                "recovery",
                JSON.stringify(recovery),
                date as string,
              );
            }

            db.prepare("UPDATE sessions SET updatedAt=? WHERE id=?").run(
              date as string,
              sessionId as string,
            );
            if (firstPrompt) {
              db.prepare(
                "UPDATE sessions SET titleState='generating' WHERE id=? AND titleState='pending'",
              ).run(sessionId as string);
            }
          } else if (write.kind === "title") {
            const [state, title, date, sessionId] = write.values;
            if (state === "completed") {
              db.prepare(
                "UPDATE sessions SET title=?,titleState='completed',updatedAt=? WHERE id=? AND titleState='generating'",
              ).run(title as string, date as string, sessionId as string);
            } else {
              db.prepare(
                "UPDATE sessions SET titleState='failed' WHERE id=? AND titleState='generating'",
              ).run(sessionId as string);
            }
          } else if (write.kind === "replay") {
            const [taskId, action, key, data] = write.values;
            writeReplay(
              db,
              taskId as string,
              action as Parameters<typeof writeReplay>[2],
              key as string | null,
              data,
            );
          } else {
            throw new Error("未知的 Store 写入类型。");
          }
        }

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return undefined;
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
        db.prepare("DELETE FROM context_token_anchors WHERE sessionId=?").run(
          request.sessionId,
        );
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

parentPort?.on("message", (request: StoreWorkerRequest) => {
  try {
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      value: handle(request),
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Store Worker 执行失败。",
    });
  }
});
