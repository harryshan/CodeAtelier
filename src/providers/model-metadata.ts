/**
 * 校验服务返回的模型容量和 token 用量，供 ResponsesProvider、预算计算和评测统计使用。
 *
 * 1. tokenCount 和 positiveLimit 约束计数及容量的数值范围。
 * 2. usageSchema 校验输入、输出、总用量及可选明细；capabilitiesSchema 校验 tokenizer 和容量上限。
 * 3. parseUsage 返回校验后的用量，缺失或不合法时返回 undefined。
 *
 * 未识别的扩展字段不用于容量判断或用量统计。没有返回数据与实际用量为零是两种情况。
 */

import { z } from "zod";

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveLimit = z.number().int().min(1024).max(100000000);

export const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  total_tokens: tokenCount,
  input_tokens_details: z
    .object({ cached_tokens: tokenCount.optional() })
    .optional(),
  output_tokens_details: z
    .object({ reasoning_tokens: tokenCount.optional() })
    .optional(),
});

export type ModelUsage = z.infer<typeof usageSchema>;

export const capabilitiesSchema = z.object({
  limits: z.object({
    max_context_window_tokens: positiveLimit,
    max_output_tokens: z.number().int().positive().max(100000000),
    max_prompt_tokens: positiveLimit.optional(),
  }),
  tokenizer: z.string().max(100).optional(),
});

export type ModelCapabilities = z.infer<typeof capabilitiesSchema>;

/** 只保留支持的用量字段；attribution 等扩展内容可能包含敏感信息，不予保存。 */
export function parseUsage(value: unknown): ModelUsage | undefined {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  const usage = parsed.data;
  if (
    usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
    (usage.input_tokens_details?.cached_tokens ?? 0) > usage.input_tokens ||
    (usage.output_tokens_details?.reasoning_tokens ?? 0) > usage.output_tokens
  ) {
    return undefined;
  }

  return usage;
}
