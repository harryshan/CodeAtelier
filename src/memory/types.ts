/**
 * 定义项目记忆 JSONL 快照及旧 Markdown 兼容文档、检索 bundle 和模型维护操作的受限数据契约。
 * FileStore、JSONL/旧 Markdown 编解码器、Mutator、Retriever 与 ToolRunner 都依赖本文件；它不读取磁盘、调用模型或写日志。
 *
 * 1. 常量限定存储文件、条目和单次维护操作的大小；摘要目录不另设条数或字符裁剪，仍接受整体模型预算。
 * 2. Zod schema 校验存储文档、维护输入及同工具的单条 read；读取与写入不混合，Mutator 仍只接受维护操作。
 * 3. TypeScript 类型描述保存后的条目、来源、文件文档和检索结果，供纯函数和运行时编排复用。
 *
 * 记忆正文始终是历史参考数据；类型契约不授予任何工作区、命令或任意文件写入权限。
 */

import { z } from "zod";

export const MEMORY_SCHEMA_VERSION = 1;
export const MAX_MEMORY_FILE_BYTES = 512 * 1024;
export const MAX_MEMORY_ENTRIES = 256;
export const MAX_MEMORY_OPERATIONS = 16;

export const memoryKindSchema = z.enum([
  "project_fact",
  "constraint",
  "decision",
  "work_item",
  "verification",
]);
export const memoryImportanceSchema = z.enum([
  "low",
  "normal",
  "high",
  "pinned",
]);
export const memoryStatusSchema = z.enum([
  "active",
  "stale",
  "archived",
  "dismissed",
]);
export const memoryConfidenceSchema = z.enum([
  "confirmed",
  "observed",
  "tentative",
]);

export const memorySourceSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128),
    eventId: z.string().max(128).nullable(),
    summary: z.string().min(1).max(500),
    filePath: z.string().min(1).max(1024).nullable(),
    fileHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

export const memoryEntrySchema = z
  .object({
    id: z.string().uuid(),
    kind: memoryKindSchema,
    title: z.string().min(1).max(160),
    statement: z.string().min(1).max(1200),
    tags: z.array(z.string().min(1).max(64)).max(12),
    importance: memoryImportanceSchema,
    status: memoryStatusSchema,
    confidence: memoryConfidenceSchema,
    expiresAt: z.string().datetime().nullable(),
    source: memorySourceSchema,
    lastReason: z.string().min(1).max(500),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().nullable(),
  })
  .strict();

export const memoryDocumentSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    projectKey: z.string().regex(/^[a-f0-9]{64}$/),
    workspace: z.string().min(1).max(4096),
    enabled: z.boolean(),
    updatedAt: z.string().datetime(),
    entries: z.array(memoryEntrySchema).max(MAX_MEMORY_ENTRIES),
  })
  .strict();

const mutationSourceSchema = z
  .object({
    summary: z.string().min(1).max(500),
    eventId: z.string().max(128).nullable(),
    filePath: z.string().min(1).max(1024).nullable(),
    fileHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

const mutationFieldsSchema = {
  kind: memoryKindSchema,
  title: z.string().min(1).max(160),
  statement: z.string().min(1).max(1200),
  tags: z.array(z.string().min(1).max(64)).max(12),
  importance: memoryImportanceSchema,
  confidence: memoryConfidenceSchema,
  expiresAt: z.string().datetime().nullable(),
  source: mutationSourceSchema,
  reason: z.string().min(1).max(500),
};

export const memoryMutationSchema = z
  .object({
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    operations: z
      .array(
        z.union([
          z
            .object({
              action: z.literal("create"),
              ...mutationFieldsSchema,
            })
            .strict(),
          z
            .object({
              action: z.literal("update"),
              id: z.string().uuid(),
              ...mutationFieldsSchema,
            })
            .strict(),
          z
            .object({
              action: z.literal("archive"),
              id: z.string().uuid(),
              reason: z.string().min(1).max(500),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(MAX_MEMORY_OPERATIONS),
  })
  .strict();

/** 沿用原工具信封；read 独立于写入批次，避免读取结果与副作用的顺序歧义。 */
export const memoryToolSchema = memoryMutationSchema.extend({
  operations: z.union([
    memoryMutationSchema.shape.operations,
    z
      .array(
        z.object({ action: z.literal("read"), id: z.string().uuid() }).strict(),
      )
      .length(1),
  ]),
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;
export type MemoryMutation = z.infer<typeof memoryMutationSchema>;
export type MemoryMutationOperation = MemoryMutation["operations"][number];

export interface MemoryBundleEntry {
  id: string;
  /** 使用已有的短标题作检索摘要，不复制正文或来源。 */
  summary: string;
}

export interface MemoryBundle {
  projectKey: string;
  version: string | null;
  entries: MemoryBundleEntry[];
  text: string;
}

export interface MemoryScope {
  workspace: string;
  sessionId: string;
  taskId: string;
}
