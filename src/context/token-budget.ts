import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import type { ModelCapabilities } from "../providers/model-metadata.js";
import { contextSize } from "./budget.js";

let encoder: Tiktoken | undefined;
export type Measure = (
  input: any[],
  instructions: string,
  tools: any[],
) => number;

export interface ContextBudget {
  unit: "tokens" | "characters";
  limit: number;
  measure: Measure;
  outputTokens?: number;
  contextWindowTokens?: number;
  safetyTokens?: number;
  tokenizer?: string;
  observeUsage?: (
    actualInput: number,
    input: any[],
    instructions: string,
    tools: any[],
  ) => void;
}

/** 只接受服务公布且本地明确支持的编码；不根据模型别名猜测 tokenizer。 */
export function createBudget(
  capabilities: ModelCapabilities | undefined,
  fallbackChars: number,
  requestedOutput = 16384,
): ContextBudget {
  if (!capabilities || capabilities.tokenizer !== "o200k_base") {
    return { unit: "characters", limit: fallbackChars, measure: contextSize };
  }

  const window = capabilities.limits.max_context_window_tokens;
  const safetyTokens = Math.max(1024, Math.ceil(window * 0.05));
  const outputTokens = Math.min(
    requestedOutput,
    capabilities.limits.max_output_tokens,
    Math.max(1, window - safetyTokens - 1024),
  );
  const limit =
    Math.min(
      window - outputTokens,
      capabilities.limits.max_prompt_tokens ?? window,
    ) - safetyTokens;
  if (limit <= 0) {
    return { unit: "characters", limit: fallbackChars, measure: contextSize };
  }

  encoder ??= new Tiktoken(o200k);
  let correction = 1;
  const rawMeasure: Measure = (input, instructions, tools) =>
    encoder!.encode(JSON.stringify({ input, instructions, tools }), [], [])
      .length;

  return {
    unit: "tokens",
    limit,
    outputTokens,
    contextWindowTokens: window,
    safetyTokens,
    tokenizer: capabilities.tokenizer,
    // 协议包装与隐藏开销无法精确复刻。特殊 token 字面量按普通文本处理。
    measure: (input, instructions, tools) =>
      Math.ceil(rawMeasure(input, instructions, tools) * correction),
    // 只上调本任务估算；不能因一次低用量就缩小安全边界。
    observeUsage: (actualInput, input, instructions, tools) => {
      correction = Math.max(
        correction,
        actualInput / Math.max(1, rawMeasure(input, instructions, tools)),
      );
    },
  };
}
