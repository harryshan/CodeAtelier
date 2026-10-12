/**
 * 管理会话历史 SQLite 的容量分片，供 Store 在不改变上层会话 API 的前提下发现、打开和轮换数据库文件。
 * Store 是唯一调用方：它只为新文件创建目标 schema，并按 session 或 task 查找所属分片；本模块不解析业务 JSON，也不执行会话写入。
 *
 * 1. 兼容现有的 history.sqlite 作为序号 0 分片，并发现同目录的 history-000001.sqlite 等后续分片。
 * 2. 统计主数据库与 WAL 文件的实际磁盘字节数；创建新会话前，已含会话且达到容量上限的最新分片会轮换到下一个文件。
 * 3. 保持单个会话始终位于其初始分片，避免跨 SQLite 文件的外键、事务和恢复语义变化；因此单个会话的一次不可分割写入仍可能使其所属分片略超阈值。
 * 4. 先只读检查整个文件集；旧版本和未验证迁移目标直接拒绝，不能在启动时隐式转换或部分升级。
 * 5. Worker 复用最多 8 个 LRU 连接和有界定位缓存；事务中的连接不驱逐。SQLite 写锁最多等待 5 秒，发现失败和正常关闭均释放连接。
 *
 * 分片不构成安全隔离，也不跨文件迁移已有会话；旧版本必须通过独立离线迁移；后续新会话才会轮换到新的文件。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { generationSourceHash } from "./history-generation.js";
import { cachedDatabase } from "./database-cache.js";

export const DEFAULT_HISTORY_SHARD_MAX_BYTES = 1024 * 1024 * 1024;

export interface HistoryShard {
  sequence: number;
  file: string;
  db: DatabaseSync;
}

function escapedExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileBytes(file: string) {
  return existsSync(file) ? statSync(file).size : 0;
}

export class HistoryShards {
  readonly all: HistoryShard[];
  private readonly connections = new Map<string, DatabaseSync>();
  private readonly locations = new Map<string, HistoryShard>();

  constructor(
    private readonly primaryFile: string,
    private readonly maxBytes = DEFAULT_HISTORY_SHARD_MAX_BYTES,
    private readonly readOnly = false,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("历史 SQLite 分片容量必须是正整数。");
    }

    if (!readOnly) {
      mkdirSync(path.dirname(primaryFile), { recursive: true });
    }

    this.all = this.discover();
    if (this.all.length === 0) {
      if (readOnly) {
        throw new Error("历史不存在。");
      }

      this.all.push(this.open(0, primaryFile));
    }
  }

  refresh() {
    const fresh = this.discover();
    for (const shard of fresh) {
      this.all.push(shard);
    }
  }

  active() {
    return this.all.at(-1)!;
  }

  /** 新会话只进入最新未满分片；已有会话继续写回原分片以维持其完整关系和事务边界。 */
  forNewSession() {
    const active = this.active();
    if (!this.hasSessions(active) || this.diskBytes(active) < this.maxBytes) {
      return active;
    }

    const next = this.open(
      active.sequence + 1,
      this.fileFor(active.sequence + 1),
    );
    this.all.push(next);

    return next;
  }

  findSession(sessionId: string) {
    const key = `session:${sessionId}`;
    const cached = this.locations.get(key);
    if (cached) {
      return cached;
    }

    const found = [...this.all]
      .reverse()
      .find((shard) =>
        Boolean(
          shard.db
            .prepare("SELECT 1 FROM sessions WHERE id=? LIMIT 1")
            .get(sessionId),
        ),
      );
    this.cacheLocation(key, found);

    return found;
  }

  findTask(taskId: string) {
    const key = `task:${taskId}`;
    const cached = this.locations.get(key);
    if (cached) {
      return cached;
    }

    const found = [...this.all]
      .reverse()
      .find((shard) =>
        Boolean(
          shard.db
            .prepare("SELECT 1 FROM tasks WHERE id=? LIMIT 1")
            .get(taskId),
        ),
      );
    this.cacheLocation(key, found);

    return found;
  }

  private cacheLocation(key: string, shard: HistoryShard | undefined) {
    if (!shard) {
      return;
    }

    if (this.locations.size >= 8192) {
      this.locations.delete(this.locations.keys().next().value!);
    }

    this.locations.set(key, shard);
  }

  maxEventId() {
    return this.all.reduce((maximum, shard) => {
      const row = shard.db
        .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events")
        .get() as { id: number };
      const sequence = shard.db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='events'")
        .get();

      return Math.max(maximum, row.id, Number(sequence?.seq ?? 0));
    }, 0);
  }

  close() {
    for (const db of this.connections.values()) {
      db.close();
    }

    this.connections.clear();
  }

  private discover() {
    const parsed = path.parse(this.primaryFile);
    const shardPattern = new RegExp(
      `^${escapedExpression(parsed.name)}-(\\d{6})${escapedExpression(parsed.ext)}$`,
    );
    const discovered: Array<{ sequence: number; file: string }> = [];

    if (existsSync(this.primaryFile)) {
      discovered.push({ sequence: 0, file: this.primaryFile });
    }

    for (const entry of readdirSync(path.dirname(this.primaryFile), {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) {
        continue;
      }

      const match = shardPattern.exec(entry.name);
      if (match) {
        discovered.push({
          sequence: Number(match[1]),
          file: path.join(path.dirname(this.primaryFile), entry.name),
        });
      }
    }

    const opened: HistoryShard[] = [];
    const existingFiles = new Set(this.all?.map((shard) => shard.file));
    const newFiles = discovered.filter(
      (shard) => !existingFiles.has(shard.file),
    );
    try {
      for (const shard of newFiles) {
        const source = new DatabaseSync(shard.file, { readOnly: true });
        try {
          if (
            source.prepare("PRAGMA user_version").get()?.user_version !== 11
          ) {
            throw new Error("历史数据库需要离线完整迁移；启动未修改源库。");
          }

          const identity = source
            .prepare(
              "SELECT state,sourceHash FROM migration_identity WHERE singleton=1",
            )
            .get();
          if (identity && identity.state !== "verified") {
            throw new Error("迁移目标尚未通过完整验证，禁止启动。");
          }

          const expectedHash = generationSourceHash(
            path.dirname(shard.file),
            path.basename(shard.file),
          );
          if (
            (typeof expectedHash === "string" &&
              identity?.sourceHash !== expectedHash) ||
            (expectedHash === null && identity)
          ) {
            throw new Error("分片身份与活动 generation 不一致，禁止混用。");
          }

          // 版本号不能掩盖缺列/部分 DDL；查询准备阶段不执行恢复写入。
          source.prepare(
            "SELECT orderKey,subagentsEnabled,startedAt,finishedAt FROM tasks LIMIT 0",
          );
          source.prepare("SELECT orderKey FROM context_snapshots LIMIT 0");
          source.prepare(
            "SELECT outcome,checkpoint FROM replay_entries LIMIT 0",
          );
          source.prepare("SELECT orderKey FROM subagents LIMIT 0");
          source.prepare(
            "SELECT version,eventId,data FROM session_statistics LIMIT 0",
          );
        } finally {
          source.close();
        }
      }

      for (const shard of newFiles.sort(
        (left, right) => left.sequence - right.sequence,
      )) {
        opened.push(this.open(shard.sequence, shard.file));
      }

      return opened;
    } catch (error) {
      // 后续分片验证/打开失败时不能留下前面分片的活动句柄。
      this.close();

      throw error;
    }
  }

  private open(sequence: number, file: string): HistoryShard {
    const connection = () => this.connection(file);

    // Getter only borrows a connection for the current synchronous operation.
    // Active transactions are never eviction candidates.
    return {
      sequence,
      file,
      get db() {
        return connection();
      },
    };
  }

  private connection(file: string): DatabaseSync {
    const cached = this.connections.get(file);
    if (cached) {
      this.connections.delete(file);
      this.connections.set(file, cached);

      return cached;
    }

    if (this.connections.size >= 8) {
      const oldest = [...this.connections].find(([, db]) => !db.isTransaction);
      if (!oldest) {
        throw new Error("分片连接均被事务占用。");
      }

      oldest[1].close();
      this.connections.delete(oldest[0]);
    }

    const existing = existsSync(file);
    // 外部读者/维护可能短暂持锁；只作有界等待，不重放结果未知的写入。
    const db = new DatabaseSync(file, {
      timeout: 5000,
      readOnly: this.readOnly,
    });
    try {
      if (!existing) {
        db.exec(SCHEMA_SQL);
      }

      db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000",
      );

      const connection = cachedDatabase(db);
      this.connections.set(file, connection);

      return connection;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private hasSessions(shard: HistoryShard) {
    return Boolean(shard.db.prepare("SELECT 1 FROM sessions LIMIT 1").get());
  }

  private diskBytes(shard: HistoryShard) {
    return fileBytes(shard.file) + fileBytes(shard.file + "-wal");
  }

  private fileFor(sequence: number) {
    const parsed = path.parse(this.primaryFile);

    return path.join(
      parsed.dir,
      `${parsed.name}-${String(sequence).padStart(6, "0")}${parsed.ext}`,
    );
  }
}
