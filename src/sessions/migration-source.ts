/**
 * 只读解析历史 schema 1--10 的迁移输入，供离线转换器与源侧验证使用。
 * 不构造 Store、不执行 schema 初始化、恢复任务或写入；调用方持有冻结的一致性副本。
 *
 * 1. inspectSource 核对版本、已知表和 SQLite 完整性；未知表或损坏直接停止。
 * 2. sourceReplayHeader 用 SQLite JSON 操作提取小元数据，避免把整任务捕获放进 JS 堆。
 * 3. sourceReplayEntries 逐条解析旧整条数组或 v2 增量，保留输入内的键顺序与缺失终态。
 * 4. sourceColumns 描述受支持的原始列；扩展列不得在隐式投影中丢失。
 */
import type { DatabaseSync } from "node:sqlite";
import type { RecordedModelExchange, RecordedToolCall } from "./replay-case.js";

export const sourceColumns: Record<string, string[]> = {
  sessions: [
    "id",
    "title",
    "workspace",
    "createdAt",
    "updatedAt",
    "titleState",
  ],
  tasks: [
    "id",
    "sessionId",
    "status",
    "createdAt",
    "startedAt",
    "finishedAt",
    "error",
    "subagentsEnabled",
  ],
  events: ["id", "sessionId", "taskId", "type", "data", "createdAt"],
  context: ["sessionId", "items"],
  context_chunks: ["sessionId", "position", "items"],
  context_token_anchors: ["sessionId", "data"],
  context_snapshots: ["id", "sessionId", "data"],
  task_replays: ["taskId", "data"],
  replay_entries: ["seq", "taskId", "kind", "itemId", "data"],
  subagents: [
    "taskId",
    "id",
    "status",
    "plan",
    "report",
    "context",
    "consumed",
    "updatedAt",
  ],
  subagent_requests: [
    "taskId",
    "subagentId",
    "requestId",
    "kind",
    "status",
    "result",
  ],
};

export function inspectSource(db: DatabaseSync) {
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (!Number.isInteger(version) || version < 1 || version > 10) {
    throw new Error("不支持的源 schema 版本。");
  }

  const checks = db.prepare("PRAGMA integrity_check(1)").all();
  if (checks.length !== 1 || checks[0]!.integrity_check !== "ok") {
    throw new Error("源数据库完整性检查失败；禁止转换或切换。");
  }

  if (db.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("源数据库存在外键异常。");
  }

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => String(row.name));
  for (const table of tables) {
    if (!sourceColumns[table]) {
      throw new Error("发现未知源表，必须先提供无损适配器。");
    }

    const columns = db.prepare(`PRAGMA table_xinfo("${table}")`).all();
    if (
      columns.some(
        (column) => !sourceColumns[table]!.includes(String(column.name)),
      )
    ) {
      throw new Error("发现未知源列，必须先提供无损适配器。");
    }
  }

  for (const required of ["sessions", "tasks", "events"]) {
    if (!tables.includes(required)) {
      throw new Error("源数据库缺少基础历史表。");
    }
  }

  return { version, tables };
}

export function sourceReplayHeader(db: DatabaseSync, taskId: string) {
  const row = db
    .prepare(
      "SELECT json_remove(data,'$.modelExchanges','$.tools') AS header, json_extract(data,'$.storageVersion') AS version FROM task_replays WHERE taskId=?",
    )
    .get(taskId);
  if (!row) {
    return undefined;
  }

  if (row.version !== null && row.version !== 2) {
    throw new Error("不支持的源 Replay 版本。");
  }

  const metadata = JSON.parse(String(row.header)) as Record<string, unknown>;
  delete metadata.storageVersion;

  return { metadata, version: row.version === 2 ? 2 : 1 };
}

export interface SourceReplayEntry {
  kind: "model" | "tool";
  sourceOrder: number;
  value: RecordedModelExchange | RecordedToolCall;
}

export function* sourceReplayEntries(
  db: DatabaseSync,
  taskId: string,
): Generator<SourceReplayEntry> {
  const header = sourceReplayHeader(db, taskId);
  if (!header) {
    return;
  }

  let order = 0;
  if (header.version === 1) {
    for (const [field, kind] of [
      ["modelExchanges", "model"],
      ["tools", "tool"],
    ] as const) {
      const row = db
        .prepare(
          "SELECT json_type(data,?) AS type FROM task_replays WHERE taskId=?",
        )
        .get(`$.${field}`, taskId);
      if (row?.type !== "array") {
        throw new Error("旧 Replay 缺少捕获数组。");
      }

      for (const entry of db
        .prepare(
          `SELECT value FROM task_replays,json_each(task_replays.data,'$.${field}') WHERE taskId=? ORDER BY CAST(key AS INTEGER)`,
        )
        .iterate(taskId)) {
        yield {
          kind,
          sourceOrder: ++order,
          value: JSON.parse(String(entry.value)),
        };
      }
    }

    return;
  }

  let previous: any[] = [];
  for (const row of db
    .prepare(
      "SELECT seq,kind,itemId,data FROM replay_entries WHERE taskId=? ORDER BY seq",
    )
    .iterate(taskId)) {
    const data = JSON.parse(String(row.data));
    if (row.kind === "model") {
      const { inputPrefix, inputSuffix, ...rest } = data;
      if (
        !Number.isSafeInteger(inputPrefix) ||
        inputPrefix < 0 ||
        inputPrefix > previous.length ||
        !Array.isArray(inputSuffix) ||
        rest.id !== row.itemId
      ) {
        throw new Error("源 Replay 增量或调用关联无效。");
      }

      previous = [...previous.slice(0, inputPrefix), ...inputSuffix];
      yield {
        kind: "model",
        sourceOrder: ++order,
        value: { ...rest, input: previous },
      };
    } else if (row.kind === "tool" && data.callId === row.itemId) {
      yield { kind: "tool", sourceOrder: ++order, value: data };
    } else {
      throw new Error("源 Replay 条目种类或调用关联无效。");
    }
  }
}
