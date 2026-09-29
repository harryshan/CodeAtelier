/**
 * 定义 Store 初始化 SQLite 数据库时执行的 SQL，保存会话历史和任务恢复信息。
 *
 * 1. 开启 WAL 和外键检查；sessions 保存会话、工作区及标题生成状态，tasks 保存排队、实际运行、结束时间、任务级 subagent 选择和错误。
 * 2. events 保存工具与对话；context_chunks 按基线与增量保存活动模型协议项，context 只供旧库迁移。
 * 3. context_snapshots 保存压缩前历史；task_replays 保存 replay 元数据及旧格式，replay_entries 增量保存模型/工具；subagent 表保存检查点与请求回执，末尾设置 user_version。
 *
 * 表结构要与 Store 中的 SQL 一起维护。修改时也要考虑旧数据库如何升级，不能只检查新建数据库。
 */

/** 会话数据库的初始结构。字段顺序与 Store 的位置参数 INSERT 语句对应。 */
export const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    titleState TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    startedAt TEXT,
    finishedAt TEXT,
    error TEXT,
    subagentsEnabled INTEGER NOT NULL DEFAULT 0 CHECK (subagentsEnabled IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    taskId TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context (
    sessionId TEXT PRIMARY KEY REFERENCES sessions(id),
    items TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_chunks (
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    position INTEGER NOT NULL,
    items TEXT NOT NULL,
    PRIMARY KEY(sessionId, position)
  );

  CREATE INDEX IF NOT EXISTS events_session ON events(sessionId, id);

  CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS context_snapshots_session ON context_snapshots(sessionId);

  CREATE TABLE IF NOT EXISTS task_replays (
    taskId TEXT PRIMARY KEY REFERENCES tasks(id),
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS replay_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId TEXT NOT NULL REFERENCES task_replays(taskId),
    kind TEXT NOT NULL CHECK (kind IN ('model', 'tool')),
    itemId TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE(taskId, kind, itemId)
  );
  CREATE INDEX IF NOT EXISTS replay_entries_task ON replay_entries(taskId, seq);

  CREATE TABLE IF NOT EXISTS subagents (
    taskId TEXT NOT NULL REFERENCES tasks(id),
    id TEXT NOT NULL,
    status TEXT NOT NULL,
    plan TEXT NOT NULL,
    report TEXT,
    context TEXT NOT NULL DEFAULT '[]',
    consumed INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY(taskId, id)
  );

  CREATE TABLE IF NOT EXISTS subagent_requests (
    taskId TEXT NOT NULL,
    subagentId TEXT NOT NULL,
    requestId TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    PRIMARY KEY(taskId, subagentId, requestId),
    FOREIGN KEY(taskId, subagentId) REFERENCES subagents(taskId, id)
  );

  PRAGMA user_version = 9;
`;
