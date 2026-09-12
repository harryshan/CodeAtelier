/**
 * 文件作用：定义本地 SQLite 历史存储的初始化结构。
 *
 * 模块协作与输入输出：
 * 由 Store 构造器执行，为本地历史数据库建立表和查询索引。
 *
 * 代码结构与执行顺序：
 * 1. 先启用 WAL 和外键检查；sessions 保存工作目录及会话信息，tasks 保存执行状态与错误。
 * 2. events 保存按顺序读取的用户、模型和工具记录，context 单独保存每个会话的活动协议上下文。
 * 3. context_snapshots 保存历史压缩来源，相关索引支持按会话与顺序查询，末尾记录数据库 user_version。
 *
 * 关键约束：
 * schema 定义与 Store SQL 必须同步；修改持久化结构须考虑已有数据库，而非只验证全新初始化。
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
