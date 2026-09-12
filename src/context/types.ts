/**
 * 文件作用：定义上下文摘要的运行时校验和持久化快照结构。
 *
 * 模块协作与输入输出：
 * 连接摘要模型输出校验、ContextManager 和 Store 的快照持久化，统一来源追溯数据形状。
 *
 * 代码结构与执行顺序：
 * 1. fact 为每条结论绑定来源索引，summarySchema 组织 completed、conclusions、verification 和 pending。
 * 2. ContextSummary 从运行时 schema 推导，减少静态类型与解析规则不一致。
 * 3. ContextSnapshot 保存版本、父快照、原始 source、切点、投影、摘要、预算与执行 ledger。
 *
 * 关键约束：
 * 新增快照字段需考虑旧记录兼容；来源和 ledger 必须保留，不能只存最终摘要文字。
 */

import { z } from "zod";

const fact = z
  .object({
    text: z.string().min(1).max(2000),
    sources: z.array(z.number().int().nonnegative()).min(1).max(20),
  })
  .strict();

/** 来源是本次归档 input 的索引；摘要只作为历史数据，不能授予权限。 */
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
  stage?: "deduplicate" | "archive" | "summary";
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
