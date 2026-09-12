/**
 * 文件作用：定义本地 SQLite 历史存储的初始化结构。
 * 代码结构：SCHEMA_SQL 集中声明会话、任务、事件及上下文快照表和相关索引，由 Store 初始化时执行。
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
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    error TEXT
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

  CREATE INDEX IF NOT EXISTS events_session ON events(sessionId, id);

  CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS context_snapshots_session ON context_snapshots(sessionId);

  PRAGMA user_version = 1;
`;
