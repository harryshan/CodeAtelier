/**
 * 定义 Store 初始化 SQLite 数据库时执行的 SQL，保存会话历史和任务恢复信息。
 *
 * 1. 开启 WAL 和外键检查；sessions 保存会话、工作区及标题生成状态，tasks 保存排队、实际运行、结束时间、任务级 subagent 选择和错误。
 * 2. events 保存工具与对话；context_chunks 按基线与增量保存活动模型协议项，context 只供旧库迁移；context_token_anchors 保存每会话一个无正文的实报校准锚点。
 * 3. context_snapshots 保存压缩前历史；Replay v3 将不可变请求与终态分离，检查点限制重建距离。
 * 4. 显式 orderKey 保留任务、快照和子任务顺序；长度和关联字段随正文维护，索引支持分页与恢复。
 * 5. 本文件仅创建目标 v11；旧数据须离线转换和验证，不能靠执行 DDL 升级已有库。
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
    subagentsEnabled INTEGER NOT NULL DEFAULT 0 CHECK (subagentsEnabled IN (0, 1)),
    orderKey INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    taskId TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    byteSize INTEGER GENERATED ALWAYS AS (length(CAST(data AS BLOB))) STORED,
    callId TEXT GENERATED ALWAYS AS (coalesce(json_extract(data,'$.toolCallId'),json_extract(data,'$.callId'))) STORED,
    toolName TEXT GENERATED ALWAYS AS (json_extract(data,'$.name')) STORED
  );

  CREATE TABLE IF NOT EXISTS context (
    sessionId TEXT PRIMARY KEY REFERENCES sessions(id),
    items TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_chunks (
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    position INTEGER NOT NULL,
    items TEXT NOT NULL,
    byteSize INTEGER GENERATED ALWAYS AS (length(CAST(items AS BLOB))) STORED,
    PRIMARY KEY(sessionId, position)
  );

  CREATE TABLE IF NOT EXISTS context_token_anchors (
    sessionId TEXT PRIMARY KEY REFERENCES sessions(id),
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS events_session ON events(sessionId, id);
  CREATE INDEX IF NOT EXISTS events_task ON events(taskId, type, id);
  CREATE INDEX IF NOT EXISTS events_call ON events(sessionId, callId, type, id);
  CREATE INDEX IF NOT EXISTS tasks_session_order ON tasks(sessionId, createdAt, orderKey);
  CREATE INDEX IF NOT EXISTS tasks_status_order ON tasks(status, createdAt, orderKey);

  CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES sessions(id),
    data TEXT NOT NULL,
    orderKey INTEGER NOT NULL DEFAULT 0,
    byteSize INTEGER GENERATED ALWAYS AS (length(CAST(data AS BLOB))) STORED
  );
  CREATE INDEX IF NOT EXISTS context_snapshots_session ON context_snapshots(sessionId);
  CREATE INDEX IF NOT EXISTS context_snapshots_order ON context_snapshots(sessionId, orderKey);

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
    outcome TEXT,
    checkpoint INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint IN (0, 1)),
    byteSize INTEGER GENERATED ALWAYS AS (length(CAST(data AS BLOB))) STORED,
    outcomeBytes INTEGER GENERATED ALWAYS AS (coalesce(length(CAST(outcome AS BLOB)),0)) STORED,
    UNIQUE(taskId, kind, itemId)
  );
  CREATE INDEX IF NOT EXISTS replay_entries_task ON replay_entries(taskId, seq);
  CREATE INDEX IF NOT EXISTS replay_model_checkpoints ON replay_entries(taskId, checkpoint, seq) WHERE kind='model';

  CREATE TABLE IF NOT EXISTS subagents (
    taskId TEXT NOT NULL REFERENCES tasks(id),
    id TEXT NOT NULL,
    status TEXT NOT NULL,
    plan TEXT NOT NULL,
    report TEXT,
    context TEXT NOT NULL DEFAULT '[]',
    consumed INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL,
    orderKey INTEGER NOT NULL DEFAULT 0,
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

  CREATE INDEX IF NOT EXISTS subagents_order ON subagents(taskId, orderKey);

  CREATE TABLE IF NOT EXISTS migration_progress (
    stage TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS migration_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
    sourceHash TEXT NOT NULL,
    adapterVersion INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared','converted','verified'))
  );
  CREATE TRIGGER IF NOT EXISTS tasks_order AFTER INSERT ON tasks WHEN new.orderKey=0 BEGIN
    UPDATE tasks SET orderKey=(SELECT coalesce(max(orderKey),0)+1 FROM tasks WHERE sessionId=new.sessionId) WHERE id=new.id;
  END;
  CREATE TRIGGER IF NOT EXISTS snapshots_order AFTER INSERT ON context_snapshots WHEN new.orderKey=0 BEGIN
    UPDATE context_snapshots SET orderKey=(SELECT coalesce(max(orderKey),0)+1 FROM context_snapshots WHERE sessionId=new.sessionId) WHERE id=new.id;
  END;
  CREATE TRIGGER IF NOT EXISTS subagents_order AFTER INSERT ON subagents WHEN new.orderKey=0 BEGIN
    UPDATE subagents SET orderKey=(SELECT coalesce(max(orderKey),0)+1 FROM subagents WHERE taskId=new.taskId) WHERE taskId=new.taskId AND id=new.id;
  END;

  PRAGMA user_version = 11;
`;
