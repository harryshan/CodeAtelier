/**
 * 在事件提交事务中维护版本化会话统计，供分页历史读取与离线迁移使用。
 * 1. appendStatistics 保留请求/usage 回退、轮次去重、缓存未知和工具结果语义，不保存正文。
 * 2. rebuildStatistics 顺序扫描单会话相关事件，供离线转换逐会话提交；失败由调用方回滚。
 * 3. readStatistics 返回独立快照，缺失投影只允许没有统计事件的新会话，禁止静默遗漏旧历史。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Event } from "../shared/types.js";
import { SessionEventStatistics } from "../shared/session-event-statistics.js";

const types = new Set([
  "model_request",
  "model_usage",
  "tool_start",
  "tool_result",
  "task_end",
]);

export function readStatistics(db: DatabaseSync, sessionId: string) {
  const row = db
    .prepare("SELECT version,data FROM session_statistics WHERE sessionId=?")
    .get(sessionId);
  if (!row) {
    const existing = db
      .prepare(
        "SELECT 1 FROM events WHERE sessionId=? AND type IN ('model_request','model_usage','tool_start','tool_result','task_end') LIMIT 1",
      )
      .get(sessionId);
    if (existing) {
      throw new Error("会话统计尚未迁移。");
    }

    return new SessionEventStatistics();
  }

  if (row.version !== 1) {
    throw new Error("统计版本不兼容。");
  }

  return SessionEventStatistics.restore(JSON.parse(String(row.data)));
}

export function appendStatistics(db: DatabaseSync, event: Event) {
  if (!types.has(event.type)) {
    return;
  }

  const row = db
    .prepare("SELECT data FROM session_statistics WHERE sessionId=?")
    .get(event.sessionId);
  const stats = row
    ? SessionEventStatistics.restore(JSON.parse(String(row.data)))
    : new SessionEventStatistics();
  stats.append(event);
  db.prepare(
    "INSERT INTO session_statistics(sessionId,version,eventId,data) VALUES(?,1,?,?) ON CONFLICT(sessionId) DO UPDATE SET eventId=excluded.eventId,data=excluded.data",
  ).run(event.sessionId, event.id, JSON.stringify(stats.exportState()));
}

export function rebuildStatistics(db: DatabaseSync, sessionId: string) {
  const stats = new SessionEventStatistics();
  let lastId = 0;
  for (const row of db
    .prepare(
      "SELECT id,sessionId,taskId,type,data,createdAt FROM events WHERE sessionId=? AND type IN ('model_request','model_usage','tool_start','tool_result','task_end') ORDER BY id",
    )
    .iterate(sessionId)) {
    const event = {
      ...row,
      data: JSON.parse(String(row.data)),
    } as unknown as Event;
    stats.append(event);
    lastId = event.id;
  }

  db.prepare(
    "INSERT OR REPLACE INTO session_statistics(sessionId,version,eventId,data) VALUES(?,1,?,?)",
  ).run(sessionId, lastId, JSON.stringify(stats.exportState()));
}
