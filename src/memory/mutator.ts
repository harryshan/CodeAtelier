/**
 * 将已校验的模型记忆操作应用到单个项目的结构化 MemoryDocument。
 * ProjectMemoryService 在 FileStore 的串行提交中调用本模块；它不读取磁盘、不执行工具，也不决定跨项目权限。
 *
 * 1. 先验证项目启用、目标 ID 唯一和逐条版本；整批任何冲突都不会部分写入。
 * 2. create 绑定当前任务来源、生成条目 ID 并拒绝完全重复的有效事实。
 * 3. update 只替换已有条目的受限字段并重新绑定当前任务来源；archive 只停止未来检索，保留可恢复记录。
 * 4. 所有路径都再次检查敏感文本和文件来源完整性，避免绕过模型工具 schema 或直接服务调用。
 */

import { randomUUID } from "node:crypto";
import {
  MAX_MEMORY_ENTRIES,
  type MemoryDocument,
  type MemoryEntry,
  type MemoryMutation,
  type MemoryScope,
} from "./types.js";
import { assertCompleteFileSource, assertSafeMemoryText } from "./redaction.js";
import {
  assertMemoryEntryVersion,
  memoryEntryVersion,
} from "./entry-version.js";

export interface AppliedMemoryOperation {
  action: "archive" | "create" | "update";
  id: string;
  version: string;
}

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function sourceFor(
  scope: MemoryScope,
  source: {
    summary: string;
    eventId: string | null;
    filePath: string | null;
    fileHash: string | null;
  },
) {
  assertCompleteFileSource(source.filePath, source.fileHash);

  return {
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    eventId: source.eventId,
    summary: source.summary,
    filePath: source.filePath,
    fileHash: source.fileHash,
  };
}

function assertSafeOperation(operation: MemoryMutation["operations"][number]) {
  const values = [operation.reason];

  if (operation.action !== "archive") {
    values.push(
      operation.title,
      operation.statement,
      operation.tags.join(" "),
      operation.source.summary,
    );
  }

  assertSafeMemoryText(...values);
}

function duplicate(
  document: MemoryDocument,
  entry: Pick<MemoryEntry, "kind" | "statement">,
) {
  return document.entries.some(
    (existing) =>
      existing.status === "active" &&
      existing.kind === entry.kind &&
      normalize(existing.statement) === normalize(entry.statement),
  );
}

/** 在单个文件的排他更新中返回新文档和不包含正文的操作摘要。 */
export function applyMemoryMutation(
  document: MemoryDocument,
  mutation: MemoryMutation,
  scope: MemoryScope,
) {
  if (!document.enabled) {
    throw new Error("当前项目记忆已停用。");
  }

  const targets = new Set<string>();
  for (const operation of mutation.operations) {
    if (operation.action === "create") {
      continue;
    }

    if (targets.has(operation.id.toLowerCase())) {
      throw new Error("同一批次不能重复修改同一记忆条目。");
    }

    targets.add(operation.id.toLowerCase());
    const entry = document.entries.find(
      (candidate) => candidate.id === operation.id,
    );
    if (!entry) {
      throw new Error("项目记忆条目不存在或不属于当前项目。");
    }

    assertMemoryEntryVersion(entry, operation.expectedVersion);
  }

  const entries = document.entries.map((entry) => ({ ...entry }));
  const applied: AppliedMemoryOperation[] = [];
  const now = new Date().toISOString();

  for (const operation of mutation.operations) {
    assertSafeOperation(operation);

    if (operation.action === "create") {
      if (entries.length >= MAX_MEMORY_ENTRIES) {
        throw new Error("项目记忆条目已达到上限。");
      }

      if (duplicate({ ...document, entries }, operation)) {
        throw new Error(
          "已存在相同的有效项目记忆；请使用 update 或 archive。 ",
        );
      }

      const entry: MemoryEntry = {
        id: randomUUID(),
        kind: operation.kind,
        title: operation.title.trim(),
        statement: operation.statement.trim(),
        tags: [...new Set(operation.tags.map((tag) => normalize(tag)))],
        importance: operation.importance,
        status: "active",
        confidence: operation.confidence,
        expiresAt: operation.expiresAt,
        source: sourceFor(scope, operation.source),
        lastReason: operation.reason.trim(),
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      };
      entries.push(entry);
      applied.push({
        action: "create",
        id: entry.id,
        version: memoryEntryVersion(entry),
      });
      continue;
    }

    const index = entries.findIndex((entry) => entry.id === operation.id);
    if (index < 0) {
      throw new Error("项目记忆条目不存在或不属于当前项目。");
    }

    const existing = entries[index];
    if (operation.action === "archive") {
      entries[index] = {
        ...existing,
        status: "archived",
        lastReason: operation.reason.trim(),
        updatedAt: now,
      };
      applied.push({
        action: "archive",
        id: existing.id,
        version: memoryEntryVersion(entries[index]),
      });
      continue;
    }

    const replacement: MemoryEntry = {
      ...existing,
      kind: operation.kind,
      title: operation.title.trim(),
      statement: operation.statement.trim(),
      tags: [...new Set(operation.tags.map((tag) => normalize(tag)))],
      importance: operation.importance,
      status: "active",
      confidence: operation.confidence,
      expiresAt: operation.expiresAt,
      source: sourceFor(scope, operation.source),
      lastReason: operation.reason.trim(),
      updatedAt: now,
    };
    entries[index] = replacement;
    applied.push({
      action: "update",
      id: existing.id,
      version: memoryEntryVersion(replacement),
    });
  }

  return {
    document: {
      ...document,
      updatedAt: now,
      entries,
    },
    result: applied,
  };
}
