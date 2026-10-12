/**
 * 将冻结的只读历史分片转换到独立 v11 文件；由离线 CLI 与合成回归调用，不启动 Store。
 * 输入必须是无活动 WAL 的一致性快照，目标是新文件或身份完全匹配的未完成目标。
 *
 * 1. fingerprint 分块计算冻结输入摘要；openSource 拒绝未合并 WAL 和源/目标文件别名。
 * 2. copyTables 按源插入顺序复制原始字符串，并将旧 context 无损映射为 position=0。
 * 3. copyReplays 流式读取旧捕获，逐条生成检查点编码；数据与批次游标同事务提交。
 * 4. verifyShard 重新走独立源解码和目标随机读取，核对全部身份、正文、顺序及业务引用。
 * 5. 仅验证通过才标记 verified；任何错误保留源和部分目标，不重放历史副作用。
 * 本模块不激活目标、不整理或删除源；afterCommit 仅用于故障注入或无正文阶段进度。
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";
import {
  inspectSource,
  sourceColumns,
  sourceReplayEntries,
  sourceReplayHeader,
} from "./migration-source.js";
import { readReplayExchange, writeReplay } from "./replay-storage.js";
import type { RecordedModelExchange, RecordedToolCall } from "./replay-case.js";

const ADAPTER_VERSION = 1;
const copyOrder = [
  "sessions",
  "tasks",
  "events",
  "context_chunks",
  "context",
  "context_token_anchors",
  "context_snapshots",
  "subagents",
  "subagent_requests",
];
const ordered = new Set(["tasks", "context_snapshots", "subagents"]);
const identities: Record<string, string[]> = {
  sessions: ["id"],
  tasks: ["id"],
  events: ["id"],
  context: ["sessionId"],
  context_chunks: ["sessionId", "position"],
  context_token_anchors: ["sessionId"],
  context_snapshots: ["id"],
  subagents: ["taskId", "id"],
  subagent_requests: ["taskId", "subagentId", "requestId"],
};
type Row = Record<string, SQLInputValue>;

export interface MigrationOptions {
  batchRows?: number;
  afterCommit?: (stage: string, cursor: number) => void;
}

export function fingerprint(file: string) {
  const hash = createHash("sha256");
  const handle = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length: number;
    while ((length = readSync(handle, buffer)) !== 0) {
      hash.update(buffer.subarray(0, length));
    }

    return hash.digest("hex");
  } finally {
    closeSync(handle);
  }
}

function openSource(source: string, target: string) {
  if (
    path.resolve(source) === path.resolve(target) ||
    (existsSync(target) &&
      (realpathSync(source) === realpathSync(target) ||
        (statSync(source).dev === statSync(target).dev &&
          statSync(source).ino === statSync(target).ino)))
  ) {
    throw new Error("源与目标不能是同一文件或别名。");
  }

  if (existsSync(source + "-wal") && statSync(source + "-wal").size > 0) {
    throw new Error(
      "冻结输入仍有 WAL；请先使用 SQLite backup API 生成一致性快照。",
    );
  }

  return new DatabaseSync(source, { readOnly: true });
}

function columns(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name));
}

function progress(db: DatabaseSync, stage: string) {
  const row = db
    .prepare("SELECT cursor,complete FROM migration_progress WHERE stage=?")
    .get(stage);

  return { cursor: Number(row?.cursor ?? 0), complete: row?.complete === 1 };
}

/** 一个进度数字指向已提交的逻辑记录数，不能在提交前单独写文件推进。 */
function saveProgress(
  db: DatabaseSync,
  stage: string,
  cursor: number,
  complete: boolean,
) {
  db.prepare(
    "INSERT INTO migration_progress(stage,cursor,complete) VALUES(?,?,?) ON CONFLICT(stage) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete",
  ).run(stage, cursor, Number(complete));
}

function batch<T>(
  db: DatabaseSync,
  stage: string,
  rows: Iterable<T>,
  write: (row: T, ordinal: number) => void,
  options: MigrationOptions,
) {
  const saved = progress(db, stage);
  if (saved.complete) {
    return;
  }

  let cursor = 0;
  let pending = 0;
  try {
    for (const row of rows) {
      cursor++;
      if (cursor <= saved.cursor) {
        continue;
      }

      if (pending === 0) {
        db.exec("BEGIN IMMEDIATE");
      }

      write(row, cursor);
      pending++;
      if (pending >= (options.batchRows ?? 128)) {
        saveProgress(db, stage, cursor, false);
        db.exec("COMMIT");
        pending = 0;
        options.afterCommit?.(stage, cursor);
      }
    }

    if (cursor < saved.cursor) {
      throw new Error("冻结输入游标与目标进度不一致。");
    }

    if (!db.isTransaction) {
      db.exec("BEGIN IMMEDIATE");
    }

    saveProgress(db, stage, cursor, true);
    db.exec("COMMIT");
    options.afterCommit?.(stage, cursor);
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }

    throw error;
  }
}

function normalizedRow(table: string, row: Row, ordinal: number): Row {
  const values = { ...row };
  delete values.sourceRow;
  if (table === "sessions" && values.titleState === undefined) {
    values.titleState = "completed";
  }

  if (table === "tasks") {
    values.startedAt ??= null;
    values.finishedAt ??= null;
    values.error ??= null;
    values.subagentsEnabled ??= 0;
  }

  if (ordered.has(table)) {
    values.orderKey = ordinal;
  }

  if (table === "context") {
    values.position = 0;
  }

  return values;
}

function copyTables(
  source: DatabaseSync,
  target: DatabaseSync,
  tables: string[],
  options: MigrationOptions,
) {
  for (const table of copyOrder.filter((table) => tables.includes(table))) {
    const destination = table === "context" ? "context_chunks" : table;
    let insert: ReturnType<DatabaseSync["prepare"]> | undefined;
    batch(
      target,
      table,
      source
        .prepare(`SELECT rowid AS sourceRow,* FROM "${table}" ORDER BY rowid`)
        .iterate() as Iterable<Row>,
      (row, ordinal) => {
        const values = normalizedRow(table, row, ordinal);
        if (
          table === "context" &&
          target
            .prepare("SELECT 1 FROM context_chunks WHERE sessionId=?")
            .get(values.sessionId!)
        ) {
          throw new Error(
            "源 context 与 context_chunks 同时存在，不能静默丢弃或拼接。",
          );
        }

        insert ??= target.prepare(
          `INSERT INTO "${destination}"(${Object.keys(values)
            .map((key) => `"${key}"`)
            .join(",")}) VALUES(${Object.keys(values)
            .map(() => "?")
            .join(",")})`,
        );
        insert.run(...Object.values(values));
      },
      options,
    );
  }
}

function copyReplays(
  source: DatabaseSync,
  target: DatabaseSync,
  tables: string[],
  options: MigrationOptions,
) {
  if (!tables.includes("task_replays")) {
    return;
  }

  for (const row of source
    .prepare("SELECT taskId FROM task_replays ORDER BY rowid")
    .iterate()) {
    const taskId = String(row.taskId);
    const stage = `replay:${taskId}`;
    if (progress(target, stage).complete) {
      continue;
    }

    if (
      !target.prepare("SELECT 1 FROM task_replays WHERE taskId=?").get(taskId)
    ) {
      target.exec("BEGIN IMMEDIATE");
      try {
        writeReplay(
          target,
          taskId,
          "create",
          null,
          sourceReplayHeader(source, taskId)!.metadata,
        );
        saveProgress(target, stage, 0, false);
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    }

    batch(
      target,
      stage,
      sourceReplayEntries(source, taskId),
      (entry) => {
        writeReplay(
          target,
          taskId,
          entry.kind === "model" ? "modelStart" : "toolStart",
          null,
          entry.value,
        );
      },
      options,
    );
  }
}

/** 任一已存列必须有显式无损映射；实际源 schema 的检查独立于版本号。 */
export async function migrateShard(
  sourceFile: string,
  targetFile: string,
  options: MigrationOptions = {},
) {
  if (
    options.batchRows !== undefined &&
    (!Number.isSafeInteger(options.batchRows) || options.batchRows < 1)
  ) {
    throw new Error("迁移批次行数必须为正整数。");
  }

  const source = openSource(sourceFile, targetFile);
  let target: DatabaseSync | undefined;
  try {
    const inventory = inspectSource(source);
    checkReferences(source, inventory.tables);
    const hash = fingerprint(sourceFile);
    if (!existsSync(targetFile)) {
      closeSync(openSync(targetFile, "wx", 0o600));
      target = new DatabaseSync(targetFile);
      target.exec(SCHEMA_SQL);
      target
        .prepare("INSERT INTO migration_identity VALUES(1,?,?,'prepared')")
        .run(hash, ADAPTER_VERSION);
    } else {
      target = new DatabaseSync(targetFile);
      const identity = target
        .prepare("SELECT * FROM migration_identity WHERE singleton=1")
        .get();
      if (
        identity?.sourceHash !== hash ||
        identity.adapterVersion !== ADAPTER_VERSION ||
        target.prepare("PRAGMA user_version").get()?.user_version !== 11
      ) {
        throw new Error("冻结输入或适配器版本与目标不一致，拒绝续跑。");
      }
    }

    target.exec(
      "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000",
    );
    copyTables(source, target, inventory.tables, options);
    copyReplays(source, target, inventory.tables, options);
    // AUTOINCREMENT 的高水位可能高于现存最大 ID；不能重用源中曾经发布过的游标。
    if (
      source
        .prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'")
        .get()
    ) {
      const sequence = source
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='events'")
        .get();
      if (sequence) {
        target
          .prepare(
            "INSERT INTO sqlite_sequence(name,seq) SELECT 'events',? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='events')",
          )
          .run(sequence.seq!);
        target
          .prepare(
            "UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='events'",
          )
          .run(sequence.seq!);
      }
    }

    target
      .prepare(
        "UPDATE migration_identity SET state='converted' WHERE singleton=1",
      )
      .run();
    target.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    target?.close();
    source.close();
  }
}

function assertSameFields(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
  category: string,
) {
  if (
    !actual ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.keys(expected).some(
      (key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
    )
  ) {
    throw new Error(`迁移验证失败：${category}正文、字段或身份不一致。`);
  }
}

function count(db: DatabaseSync, table: string) {
  return Number(
    db.prepare(`SELECT count(*) AS count FROM "${table}"`).get()!.count,
  );
}

function checkReferences(db: DatabaseSync, tables: string[]) {
  const has = (table: string) => tables.includes(table);
  const checks = [
    "SELECT 1 FROM tasks t LEFT JOIN sessions s ON s.id=t.sessionId WHERE s.id IS NULL LIMIT 1",
    "SELECT 1 FROM events e LEFT JOIN tasks t ON t.id=e.taskId WHERE t.id IS NULL OR t.sessionId<>e.sessionId LIMIT 1",
  ];
  for (const table of [
    "context",
    "context_chunks",
    "context_token_anchors",
    "context_snapshots",
  ].filter(has)) {
    checks.push(
      `SELECT 1 FROM "${table}" c LEFT JOIN sessions s ON s.id=c.sessionId WHERE s.id IS NULL LIMIT 1`,
    );
  }

  for (const table of ["task_replays", "subagents"].filter(has)) {
    checks.push(
      `SELECT 1 FROM "${table}" c LEFT JOIN tasks t ON t.id=c.taskId WHERE t.id IS NULL LIMIT 1`,
    );
  }

  if (has("replay_entries")) {
    checks.push(
      "SELECT 1 FROM replay_entries e LEFT JOIN task_replays r ON e.taskId=r.taskId WHERE r.taskId IS NULL LIMIT 1",
    );
  }

  if (has("subagent_requests")) {
    checks.push(
      "SELECT 1 FROM subagent_requests r LEFT JOIN subagents s ON s.taskId=r.taskId AND s.id=r.subagentId WHERE s.id IS NULL LIMIT 1",
    );
  }

  if (checks.some((sql) => db.prepare(sql).get())) {
    throw new Error("数据库存在孤立或跨会话业务引用，禁止切换。");
  }

  if (has("context_snapshots")) {
    const parents = new Map<string, string | null>();
    for (const row of db
      .prepare(
        "SELECT id,sessionId,json_extract(data,'$.id') AS bodyId,json_extract(data,'$.sessionId') AS bodySession,json_extract(data,'$.parentId') AS parentId FROM context_snapshots",
      )
      .iterate()) {
      if (row.id !== row.bodyId || row.sessionId !== row.bodySession) {
        throw new Error("快照正文身份与关系列不一致。");
      }

      const parent = row.parentId === null ? null : String(row.parentId);
      if (
        parent &&
        !db
          .prepare("SELECT 1 FROM context_snapshots WHERE id=? AND sessionId=?")
          .get(parent, row.sessionId!)
      ) {
        throw new Error("快照父链缺失或跨会话。");
      }

      parents.set(String(row.id), parent);
    }

    for (const id of parents.keys()) {
      const visited = new Set<string>();
      let current: string | null = id;
      while (current !== null) {
        if (visited.has(current)) {
          throw new Error("快照父链存在循环。");
        }

        visited.add(current);
        current = parents.get(current) ?? null;
      }
    }
  }
}

/** 全量只读验证：转换写入器不参与生成目标期望值，任何差异都阻止 verified。 */
export function verifyShard(sourceFile: string, targetFile: string) {
  const source = openSource(sourceFile, targetFile);
  const target = new DatabaseSync(targetFile, { readOnly: true });
  try {
    const inventory = inspectSource(source);
    const identity = target
      .prepare("SELECT * FROM migration_identity WHERE singleton=1")
      .get();
    if (
      identity?.sourceHash !== fingerprint(sourceFile) ||
      identity.adapterVersion !== ADAPTER_VERSION ||
      !["converted", "verified"].includes(String(identity.state))
    ) {
      throw new Error("目标状态或冻结输入不符合验证条件。");
    }

    if (
      target
        .prepare("PRAGMA integrity_check")
        .all()
        .some((row) => row.integrity_check !== "ok") ||
      target.prepare("PRAGMA foreign_key_check").get()
    ) {
      throw new Error("目标完整性或外键检查失败。");
    }

    const targetTables = [
      ...Object.keys(sourceColumns),
      "migration_progress",
      "migration_identity",
    ];
    checkReferences(source, inventory.tables);
    checkReferences(target, targetTables);
    const sourceHasSequence = source
      .prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'")
      .get();
    const sourceMaximum = Number(
      source.prepare("SELECT coalesce(max(id),0) AS id FROM events").get()!.id,
    );
    const sourceSequence = sourceHasSequence
      ? Number(
          source
            .prepare("SELECT seq FROM sqlite_sequence WHERE name='events'")
            .get()?.seq ?? 0,
        )
      : 0;
    const targetSequence = Number(
      target
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='events'")
        .get()?.seq ?? 0,
    );
    if (targetSequence !== Math.max(sourceMaximum, sourceSequence)) {
      throw new Error("事件游标高水位不一致，不能重用已发布的 ID。");
    }

    const counts: Record<string, number> = {};
    for (const table of copyOrder) {
      const destination = table === "context" ? "context_chunks" : table;
      counts[table] = inventory.tables.includes(table)
        ? count(source, table)
        : 0;
      if (
        table !== "context" &&
        table !== "context_chunks" &&
        count(target, destination) !== counts[table]
      ) {
        throw new Error("迁移覆盖验证失败：记录数量不一致。");
      }

      if (!inventory.tables.includes(table)) {
        continue;
      }

      const keys = identities[table]!;
      const sourceFields = columns(source, table);
      const fields = [
        ...sourceFields,
        ...(table === "sessions" && !sourceFields.includes("titleState")
          ? ["titleState"]
          : []),
      ];
      const select = target.prepare(
        `SELECT ${fields.map((key) => `"${key}"`).join(",")} FROM "${destination}" WHERE ${keys.map((key) => `"${key}"=?`).join(" AND ")}${table === "context" ? " AND position=0" : ""}`,
      );
      for (const row of source.prepare(`SELECT * FROM "${table}"`).iterate()) {
        const actual = select.get(...keys.map((key) => row[key]!));
        const expected = {
          ...row,
          ...(table === "sessions" && !sourceFields.includes("titleState")
            ? { titleState: "completed" }
            : {}),
        };
        assertSameFields(actual, expected, table);
      }

      if (ordered.has(table)) {
        const sourceOrder = source
          .prepare(`SELECT ${keys.join(",")} FROM "${table}" ORDER BY rowid`)
          .all();
        const targetOrder = target
          .prepare(`SELECT ${keys.join(",")} FROM "${table}" ORDER BY orderKey`)
          .all();
        if (JSON.stringify(sourceOrder) !== JSON.stringify(targetOrder)) {
          throw new Error("迁移验证失败：显式顺序与源插入顺序不一致。");
        }
      }
    }

    if (
      count(target, "context") !== 0 ||
      count(target, "context_chunks") !==
        counts.context! + counts.context_chunks!
    ) {
      throw new Error("上下文迁移覆盖不完整或重复。");
    }

    let replayEntries = 0;
    if (
      count(target, "task_replays") !==
      (inventory.tables.includes("task_replays")
        ? count(source, "task_replays")
        : 0)
    ) {
      throw new Error("Replay 捕获覆盖不完整。");
    }

    if (inventory.tables.includes("task_replays")) {
      for (const row of source
        .prepare("SELECT taskId FROM task_replays ORDER BY rowid")
        .iterate()) {
        const taskId = String(row.taskId);
        const actualHeader = JSON.parse(
          String(
            target
              .prepare("SELECT data FROM task_replays WHERE taskId=?")
              .get(taskId)?.data,
          ),
        );
        if (actualHeader.storageVersion !== 3) {
          throw new Error("目标 Replay 未转换。");
        }

        delete actualHeader.storageVersion;
        assertSameFields(
          actualHeader,
          sourceReplayHeader(source, taskId)!.metadata,
          "Replay 元数据",
        );
        const targetOrder = target
          .prepare(
            "SELECT kind,itemId FROM replay_entries WHERE taskId=? ORDER BY seq",
          )
          .iterate(taskId);
        for (const entry of sourceReplayEntries(source, taskId)) {
          const key =
            entry.kind === "model"
              ? (entry.value as RecordedModelExchange).id
              : (entry.value as RecordedToolCall).callId;
          const position = targetOrder.next();
          if (
            position.done ||
            position.value.kind !== entry.kind ||
            position.value.itemId !== key
          ) {
            throw new Error("Replay 捕获顺序不一致。");
          }

          let actual: unknown;
          if (entry.kind === "model") {
            actual = readReplayExchange(target, taskId, key);
          } else {
            const tool = target
              .prepare(
                "SELECT data,outcome FROM replay_entries WHERE taskId=? AND kind='tool' AND itemId=?",
              )
              .get(taskId, key)!;
            actual = {
              ...JSON.parse(String(tool.data)),
              ...(tool.outcome === null
                ? {}
                : JSON.parse(String(tool.outcome))),
            };
          }

          assertSameFields(
            actual as Record<string, unknown> | undefined,
            entry.value as unknown as Record<string, unknown>,
            "Replay 请求/工具",
          );
          replayEntries++;
        }

        if (!targetOrder.next().done) {
          throw new Error("Replay 存在意外新增记录。");
        }
      }
    }

    if (replayEntries !== count(target, "replay_entries")) {
      throw new Error("Replay 存在遗漏或孤立记录。");
    }

    return {
      counts,
      replayEntries,
      sourceHash: String(identity.sourceHash),
      adapterVersion: ADAPTER_VERSION,
    };
  } finally {
    target.close();
    source.close();
  }
}

/** 验证和盖章用于离线唯一操作者；标记只是启动门禁，不替代 generation 的整体激活。 */
export function verifyAndSealShard(sourceFile: string, targetFile: string) {
  const report = verifyShard(sourceFile, targetFile);
  const db = new DatabaseSync(targetFile);
  try {
    db.exec("PRAGMA synchronous=FULL");
    db.prepare(
      "UPDATE migration_identity SET state='verified' WHERE singleton=1 AND sourceHash=? AND adapterVersion=?",
    ).run(report.sourceHash, ADAPTER_VERSION);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }

  return report;
}
