/**
 * 定义摘要的校验规则，以及 Store 保存的上下文快照格式。
 * 摘要模型的返回值先通过这里的 schema 校验，再由 ContextManager 组织成快照。
 *
 * 1. fact 给每条摘要结论附上来源索引；summarySchema 分别保存已完成事项、结论、验证和待办。
 * 2. ContextSummary 从 schema 推导类型，避免类型声明与实际校验规则各写一套。
 * 3. ContextSnapshot 保存版本、父快照、原文、切点、压缩结果、预算和工具执行记录。
 *
 * 修改快照格式时要兼容旧记录。原文来源和执行状态是恢复所需的数据，不能只留下摘要文字。
 */

import { z } from "zod";

const fact = z
  .object({
    text: z.string().min(1).max(2000),
    sources: z.array(z.number().int().nonnegative()).min(1).max(20),
  })
  .strict();

/** 来源编号对应本次归档的 input；摘要是历史记录，不是新的授权。 */
export const summarySchema = z
  .object({
    completed: z.array(fact).max(20),
    conclusions: z.array(fact).max(20),
    verification: z.array(fact).max(20),
    pending: z.array(fact).max(20),
  })
  .strict();

export type ContextSummary = z.infer<typeof summarySchema>;

export interface ContextSnapshot {
  version: 1;
  stage?: "deduplicate" | "archive" | "summary" | "fallback";
  note?: string;
  projections?: { index: number; output: string }[];
  id: string;
  sessionId: string;
  parentId: string | null;
  sourceHash: string;
  model: string;
  createdAt: string;
  beforeChars: number;
  afterChars: number;
  budget?: {
    unit: "tokens" | "characters";
    limit: number;
    before: number;
    after: number;
  };
  cut: number;
  source: any[];
  summaries: ContextSummary[];
  ledger: {
    callId: string;
    name: string;
    status: "recorded" | "unknown";
    result: string;
  }[];
}
