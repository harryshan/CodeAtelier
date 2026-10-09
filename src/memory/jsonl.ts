/**
 * 在项目记忆 JSONL 快照和 MemoryDocument 之间转换，供 FileStore 读取、迁移及完整快照写入。
 * 不读取文件、不调用模型；所有错误使用受控描述，不能回显原始 JSON 或记忆正文。
 *
 * 1. record schema 固定首行 project 元数据及后续 memory/entry 记录，复用现有字段与大小契约。
 * 2. validateEntries 拒绝重复 ID 和敏感内容，保留条目原顺序，不排序、不截断或合并重复记录。
 * 3. parseMemoryJsonl 逐行严格解析；支持 LF/CRLF 和无末尾换行，拒绝 BOM、空行及任何坏记录。
 * 4. serializeMemoryJsonl 先校验整个文档，再生成带末尾 LF 的完整快照，不生成追加事件或 Markdown 结构。
 */

import { z } from "zod";
import {
  MAX_MEMORY_FILE_BYTES,
  memoryDocumentSchema,
  memoryEntrySchema,
  type MemoryDocument,
  type MemoryEntry,
} from "./types.js";
import { assertSafeMemoryText } from "./redaction.js";

const projectRecordSchema = memoryDocumentSchema
  .omit({ entries: true })
  .extend({ type: z.literal("project") });
const entryRecordSchema = z
  .object({
    type: z.literal("memory"),
    entry: memoryEntrySchema,
  })
  .strict();

class MemoryJsonlParseError extends Error {
  constructor(line: number, message: string) {
    super(`项目记忆 JSONL 第 ${line} 行无效：${message}`);
    this.name = "MemoryJsonlParseError";
  }
}

function validateEntries(entries: MemoryEntry[]) {
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const id = entry.id.toLowerCase();
    if (ids.has(id)) {
      throw new MemoryJsonlParseError(index + 2, "条目 ID 重复。");
    }

    ids.add(id);
    assertSafeMemoryText(
      entry.title,
      entry.statement,
      entry.tags.join(" "),
      entry.source.summary,
      entry.lastReason,
    );
  }
}

function checkSize(text: string) {
  if (Buffer.byteLength(text, "utf8") > MAX_MEMORY_FILE_BYTES) {
    throw new Error("项目记忆文件超过 512 KiB 限制。");
  }
}

function parseRecord(text: string, line: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MemoryJsonlParseError(line, "必须是完整 JSON 记录。");
  }
}

export function parseMemoryJsonl(text: string): MemoryDocument {
  checkSize(text);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const header = projectRecordSchema.safeParse(parseRecord(lines[0] ?? "", 1));
  if (!header.success) {
    throw new MemoryJsonlParseError(1, "项目元数据不符合契约。");
  }

  const entries: MemoryEntry[] = [];
  for (let index = 1; index < lines.length; index++) {
    const record = entryRecordSchema.safeParse(
      parseRecord(lines[index], index + 1),
    );
    if (!record.success) {
      throw new MemoryJsonlParseError(index + 1, "记忆记录不符合契约。");
    }

    entries.push(record.data.entry);
  }

  const parsed = memoryDocumentSchema.safeParse({
    schemaVersion: header.data.schemaVersion,
    projectKey: header.data.projectKey,
    workspace: header.data.workspace,
    enabled: header.data.enabled,
    updatedAt: header.data.updatedAt,
    entries,
  });
  if (!parsed.success) {
    throw new MemoryJsonlParseError(1, "文档不符合记忆存储契约。");
  }

  validateEntries(parsed.data.entries);

  return parsed.data;
}

export function serializeMemoryJsonl(document: MemoryDocument): string {
  const parsed = memoryDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new MemoryJsonlParseError(1, "文档不符合记忆存储契约。");
  }

  validateEntries(parsed.data.entries);
  const { entries, ...metadata } = parsed.data;
  const records = [
    JSON.stringify({ type: "project", ...metadata }),
    ...entries.map((entry) => JSON.stringify({ type: "memory", entry })),
  ];
  const text = `${records.join("\n")}\n`;
  checkSize(text);

  return text;
}
