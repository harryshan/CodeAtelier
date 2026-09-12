/**
 * 文件作用：定义上下文摘要的运行时校验和持久化快照结构。
 * 代码结构：先定义带来源的事实及摘要 schema，再声明摘要类型与包含原文、投影、预算和执行清单的快照接口。
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
