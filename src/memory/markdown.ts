/**
 * 在受限 Markdown 格式与内存中的 MemoryDocument 之间转换，并为外部手工编辑提供严格错误边界。
 * FileStore 只通过本模块读取或生成项目记忆文件；Mutator 永远处理已经解析和校验过的结构化条目。
 *
 * 1. front matter 只接受固定的标量键和 JSON 字符串，不加载通用 YAML 或执行反序列化逻辑。
 * 2. 固定二级分类、三级条目及 metadata 行确定条目边界；未知键、重复键或缺失字段均以行号失败。
 * 3. 序列化使用稳定顺序和 UTF-8 可读 Markdown，归档条目仍保留在文件中供用户恢复。
 *
 * 解析不改写文件；调用方在遇到错误时必须保留用户磁盘内容并安全降级。
 */

import {
  MEMORY_SCHEMA_VERSION,
  type MemoryDocument,
  type MemoryEntry,
  memoryDocumentSchema,
} from "./types.js";
import { assertSafeMemoryText } from "./redaction.js";

const metadataKeys = [
  "status",
  "importance",
  "confidence",
  "tags",
  "source",
  "reason",
  "createdAt",
  "updatedAt",
  "lastUsedAt",
  "expiresAt",
] as const;

export class MemoryParseError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`项目记忆第 ${line} 行无效：${message}`);
    this.name = "MemoryParseError";
  }
}

function parseJsonValue(value: string, line: number) {
  try {
    return JSON.parse(value);
  } catch {
    throw new MemoryParseError(line, "必须是 JSON 标量或数组。");
  }
}

function parseFrontMatter(lines: string[]) {
  if (lines[0] !== "---") {
    throw new MemoryParseError(1, "文件必须以 front matter 分隔符开始。");
  }

  const closingLine = lines.indexOf("---", 1);
  if (closingLine < 0) {
    throw new MemoryParseError(1, "缺少 front matter 结束分隔符。");
  }

  const values = new Map<string, unknown>();
  const allowed = new Set([
    "schemaVersion",
    "projectKey",
    "workspace",
    "enabled",
    "updatedAt",
  ]);

  for (let index = 1; index < closingLine; index++) {
    const match = /^(\w+): (.+)$/.exec(lines[index]);
    if (!match || !allowed.has(match[1]) || values.has(match[1])) {
      throw new MemoryParseError(
        index + 1,
        "front matter 键无效、重复或格式不正确。",
      );
    }

    const [, key, raw] = match;
    const value =
      key === "schemaVersion"
        ? Number(raw)
        : key === "enabled"
          ? raw === "true"
          : parseJsonValue(raw, index + 1);
    values.set(key, value);
  }

  return {
    closingLine,
    values: {
      schemaVersion: values.get("schemaVersion"),
      projectKey: values.get("projectKey"),
      workspace: values.get("workspace"),
      enabled: values.get("enabled"),
      updatedAt: values.get("updatedAt"),
    },
  };
}

function parseEntry(
  kind: string,
  titleMatch: RegExpExecArray,
  lines: string[],
  startLine: number,
): MemoryEntry {
  const metadata = new Map<string, unknown>();
  let cursor = 0;

  while (cursor < lines.length && lines[cursor].startsWith("- ")) {
    const match = /^- (\w+): (.+)$/.exec(lines[cursor]);
    if (
      !match ||
      !metadataKeys.includes(match[1] as never) ||
      metadata.has(match[1])
    ) {
      throw new MemoryParseError(
        startLine + cursor,
        "条目 metadata 无效、重复或格式不正确。",
      );
    }

    const [, key, raw] = match;

    const value = ["status", "importance", "confidence"].includes(key)
      ? raw
      : parseJsonValue(raw, startLine + cursor);
    metadata.set(key, value);
    cursor++;
  }

  if (lines[cursor] !== "") {
    throw new MemoryParseError(
      startLine + cursor,
      "metadata 后必须有一个空行。",
    );
  }

  cursor++;

  const statement = lines.slice(cursor).join("\n").trim();
  const rawEntry = {
    id: titleMatch[1],
    kind,
    title: titleMatch[2],
    statement,
    status: metadata.get("status"),
    importance: metadata.get("importance"),
    confidence: metadata.get("confidence"),
    tags: metadata.get("tags"),
    source: metadata.get("source"),
    lastReason: metadata.get("reason"),
    createdAt: metadata.get("createdAt"),
    updatedAt: metadata.get("updatedAt"),
    lastUsedAt: metadata.get("lastUsedAt"),
    expiresAt: metadata.get("expiresAt"),
  };
  const parsed = memoryDocumentSchema.shape.entries.element.safeParse(rawEntry);

  if (!parsed.success) {
    throw new MemoryParseError(startLine, "条目字段缺失或不符合受限契约。");
  }

  assertSafeMemoryText(
    parsed.data.title,
    parsed.data.statement,
    parsed.data.tags.join(" "),
    parsed.data.source.summary,
    parsed.data.lastReason,
  );

  return parsed.data;
}

/** 解析由本系统生成或用户直接编辑的完整记忆文件，绝不猜测格式边界。 */
export function parseMemoryDocument(text: string): MemoryDocument {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const frontMatter = parseFrontMatter(lines);

  let cursor = frontMatter.closingLine + 1;

  if (lines[cursor] === "") {
    cursor++;
  }

  if (lines[cursor] !== "# 项目记忆") {
    throw new MemoryParseError(cursor + 1, "缺少固定的项目记忆标题。");
  }

  cursor++;

  const entries: MemoryEntry[] = [];
  let kind: string | undefined;

  while (cursor < lines.length) {
    if (lines[cursor] === "") {
      cursor++;
      continue;
    }

    const category = /^## ([a-z_]+)$/.exec(lines[cursor]);
    if (category) {
      kind = category[1];
      cursor++;
      continue;
    }

    const heading = /^### \[([0-9a-f-]{36})\] (.+)$/.exec(lines[cursor]);

    if (!heading || !kind) {
      throw new MemoryParseError(cursor + 1, "条目必须位于固定分类标题下。");
    }

    const entryStart = cursor;
    cursor++;
    const bodyStart = cursor;
    while (
      cursor < lines.length &&
      !lines[cursor].startsWith("## ") &&
      !lines[cursor].startsWith("### ")
    ) {
      cursor++;
    }

    const body = lines.slice(bodyStart, cursor);

    while (body.at(-1) === "") {
      body.pop();
    }

    entries.push(parseEntry(kind, heading, body, entryStart + 2));
  }

  const parsed = memoryDocumentSchema.safeParse({
    ...frontMatter.values,
    entries,
  });
  if (!parsed.success) {
    throw new MemoryParseError(
      1,
      "front matter 或条目集合不符合记忆文件契约。",
    );
  }

  return parsed.data;
}

function serializeEntry(entry: MemoryEntry) {
  return [
    `### [${entry.id}] ${entry.title}`,
    `- status: ${entry.status}`,
    `- importance: ${entry.importance}`,
    `- confidence: ${entry.confidence}`,
    `- tags: ${JSON.stringify(entry.tags)}`,
    `- source: ${JSON.stringify(entry.source)}`,
    `- reason: ${JSON.stringify(entry.lastReason)}`,
    `- createdAt: ${JSON.stringify(entry.createdAt)}`,
    `- updatedAt: ${JSON.stringify(entry.updatedAt)}`,
    `- lastUsedAt: ${JSON.stringify(entry.lastUsedAt)}`,
    `- expiresAt: ${JSON.stringify(entry.expiresAt)}`,
    "",
    entry.statement,
  ].join("\n");
}

/** 生成稳定、可读、可人工审阅的 UTF-8 Markdown；不会产生通用 YAML 特性。 */
export function serializeMemoryDocument(document: MemoryDocument) {
  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of document.entries) {
    const entries = grouped.get(entry.kind) ?? [];
    entries.push(entry);
    grouped.set(entry.kind, entries);
  }

  const body = ["# 项目记忆"];
  for (const [kind, entries] of grouped) {
    body.push("", `## ${kind}`);
    for (const entry of entries) {
      body.push("", serializeEntry(entry));
    }
  }

  return [
    "---",
    `schemaVersion: ${MEMORY_SCHEMA_VERSION}`,
    `projectKey: ${JSON.stringify(document.projectKey)}`,
    `workspace: ${JSON.stringify(document.workspace)}`,
    `enabled: ${document.enabled}`,
    `updatedAt: ${JSON.stringify(document.updatedAt)}`,
    "---",
    "",
    ...body,
    "",
  ].join("\n");
}
