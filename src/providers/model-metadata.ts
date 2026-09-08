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

/** 只保留数值用量；不持久化 attribution 等可能包含内容或标识的扩展字段。 */
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
