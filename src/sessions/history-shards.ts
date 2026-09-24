/**
 * 管理会话历史 SQLite 的容量分片，供 Store 在不改变上层会话 API 的前提下发现、打开和轮换数据库文件。
 * Store 是唯一调用方：它在每个分片上执行同一 schema/migration，并按 session 或 task 查找所属分片；本模块不解析业务 JSON，也不执行会话写入。
 *
 * 1. 兼容现有的 history.sqlite 作为序号 0 分片，并发现同目录的 history-000001.sqlite 等后续分片。
 * 2. 统计主数据库与 WAL 文件的实际磁盘字节数；创建新会话前，已含会话且达到容量上限的最新分片会轮换到下一个文件。
 * 3. 保持单个会话始终位于其初始分片，避免跨 SQLite 文件的外键、事务和恢复语义变化；因此单个会话的一次不可分割写入仍可能使其所属分片略超阈值。
 * 4. 打开含会话的旧分片时先用 SQLite 一致性快照备份到数据目录 backups；失败则拒绝升级。
 * 5. 发现任何后续分片失败时关闭已打开连接；正常 close 关闭全部连接，Worker 按单一分片路径短暂打开自己的连接。
 *
 * 分片不构成安全隔离，也不跨文件迁移已有会话；版本升级前会备份旧数据，后续新会话才会轮换到新的文件。
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.js";

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

  constructor(
    private readonly primaryFile: string,
    private readonly maxBytes = DEFAULT_HISTORY_SHARD_MAX_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("历史 SQLite 分片容量必须是正整数。");
    }

    mkdirSync(path.dirname(primaryFile), { recursive: true });
    this.all = this.discover();
    if (this.all.length === 0) {
      this.all.push(this.open(0, primaryFile));
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
    return [...this.all]
      .reverse()
      .find((shard) =>
        Boolean(
          shard.db
            .prepare("SELECT 1 FROM sessions WHERE id=? LIMIT 1")
            .get(sessionId),
        ),
      );
  }

  findTask(taskId: string) {
    return [...this.all]
      .reverse()
      .find((shard) =>
        Boolean(
          shard.db
            .prepare("SELECT 1 FROM tasks WHERE id=? LIMIT 1")
            .get(taskId),
        ),
      );
  }

  maxEventId() {
    return this.all.reduce((maximum, shard) => {
      const row = shard.db
        .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events")
        .get() as { id: number };

      return Math.max(maximum, row.id);
    }, 0);
  }

  close() {
    for (const shard of this.all) {
      shard.db.close();
    }
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
    try {
      for (const shard of discovered.sort(
        (left, right) => left.sequence - right.sequence,
      )) {
        opened.push(this.open(shard.sequence, shard.file));
      }

      return opened;
    } catch (error) {
      // 后续分片备份/迁移失败时不能留下前面分片的活动句柄。
      for (const shard of opened) {
        shard.db.close();
      }

      throw error;
    }
  }

  private open(sequence: number, file: string): HistoryShard {
    const existing = existsSync(file);
    const db = new DatabaseSync(file);
    try {
      if (existing) {
        const version = db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        const sessionsTable = db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'",
          )
          .get();
        if (
          version.user_version < 8 &&
          sessionsTable &&
          db.prepare("SELECT 1 FROM sessions LIMIT 1").get()
        ) {
          const backupDirectory = path.join(path.dirname(file), "backups");
          mkdirSync(backupDirectory, { recursive: true });
          const destination = path.join(
            backupDirectory,
            `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.sqlite`,
          );
          // VACUUM INTO 包含已提交的 WAL 内容；不能直接复制正在使用的主库文件。
          db.prepare("VACUUM INTO ?").run(destination);
        }
      }

      db.exec(SCHEMA_SQL);

      return { sequence, file, db };
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
