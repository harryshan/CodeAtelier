/**
 * 定义 Store 初始化 SQLite 数据库时执行的 SQL，保存会话历史和任务恢复信息。
 *
 * 1. 开启 WAL 和外键检查；sessions 保存会话、工作区及标题生成状态，tasks 保存排队、实际运行、结束时间和错误。
 * 2. events 保存按顺序读取的对话与工具事件；context 保存每个会话当前使用的模型协议记录。
 * 3. context_snapshots 保存压缩前的历史；task_replays 保存高保真本地 replay 捕获，末尾设置 user_version。
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

  CREATE TABLE IF NOT EXISTS task_replays (
    taskId TEXT PRIMARY KEY REFERENCES tasks(id),
    data TEXT NOT NULL
  );

  PRAGMA user_version = 5;
`;
