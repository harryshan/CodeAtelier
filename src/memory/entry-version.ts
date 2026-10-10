/**
 * 为单条项目记忆生成与 JSON 排版、对象键顺序无关的内容版本。
 * Retriever、Service 和 Mutator 共用本模块；输入为已校验条目，输出为 SHA-256，不读写文件。
 * 1. canonicalValue 递归排序对象键，保留数组顺序与所有字段值，包括来源、状态和时间。
 * 2. memoryEntryVersion 对完整条目规范化后计算版本，不包含其他条目或项目更新时间。
 * 3. assertMemoryEntryVersion 拒绝目标条目过期版本；错误只含条目 ID，不含正文或来源。
 */

import { createHash } from "node:crypto";
import type { MemoryEntry } from "./types.js";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }

  return value;
}

export function memoryEntryVersion(entry: MemoryEntry): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(entry)))
    .digest("hex");
}

export class MemoryVersionConflictError extends Error {
  constructor(id: string) {
    super(
      `项目记忆条目 ${id} 已被其他操作更新，请在获得该条目的新版本后重新决定。`,
    );
    this.name = "MemoryVersionConflictError";
  }
}

export function assertMemoryEntryVersion(
  entry: MemoryEntry,
  expectedVersion: string,
) {
  if (memoryEntryVersion(entry) !== expectedVersion) {
    throw new MemoryVersionConflictError(entry.id);
  }
}
