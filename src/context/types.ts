/**
 * 定义摘要的校验规则，以及 Store 保存的上下文快照格式。
 * 摘要模型的返回值先通过这里的 schema 校验，再由 ContextManager 组织成快照。
 *
 * 1. fact 校验非空、有界的单条文本和非空整数来源；summarySchema 定义四类结论，不限制条目或来源数量。
 * 2. ContextSummary 从 schema 推导类型，避免类型声明与实际校验规则各写一套。
 * 3. contextSnapshotSchema 在跨进程写入前完整校验快照；ContextSnapshot 直接从 schema 推导，避免 Runtime 可伪造会话归属或父链。
 *
 * 修改快照格式时要兼容旧记录。原文来源和执行状态是恢复所需的数据，不能只留下摘要文字。
 */

import { z } from "zod";

const fact = z
  .object({
    text: z.string().min(1).max(2000),
    sources: z.array(z.number().int().nonnegative()).min(1),
  })
  .strict();

/** 来源编号对应本次归档的 input；摘要是历史记录，不是新的授权。 */
export const summarySchema = z
  .object({
    completed: z.array(fact),
    conclusions: z.array(fact),
    verification: z.array(fact),
    pending: z.array(fact),
  })
  .strict();

export type ContextSummary = z.infer<typeof summarySchema>;

const snapshotIdentifier = z.string().min(1).max(120);

export const contextSnapshotSchema = z
  .object({
    version: z.literal(1),
    stage: z.enum(["deduplicate", "archive", "summary", "fallback"]).optional(),
    note: z.string().max(20_000).optional(),
    projections: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            output: z.string().max(2_000_000),
          })
          .strict(),
      )
      .max(10_000)
      .optional(),
    id: snapshotIdentifier,
    sessionId: snapshotIdentifier,
    parentId: snapshotIdentifier.nullable(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
    model: z.string().min(1).max(1_000),
    createdAt: z.string().datetime(),
    beforeChars: z.number().int().nonnegative(),
    afterChars: z.number().int().nonnegative(),
    budget: z
      .object({
        unit: z.enum(["tokens", "characters"]),
        limit: z.number().int().nonnegative(),
        before: z.number().int().nonnegative(),
        after: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    cut: z.number().int().nonnegative(),
    source: z.array(z.unknown()).max(100_000),
    summaries: z.array(summarySchema).max(10_000),
    ledger: z
      .array(
        z
          .object({
            callId: snapshotIdentifier,
            name: z.string().min(1).max(1_000),
            status: z.enum(["recorded", "unknown"]),
            result: z.string().max(2_000_000),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;
