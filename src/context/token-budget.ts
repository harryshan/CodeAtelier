/**
 * 根据服务返回的模型容量，为 Engine 和 ContextManager 计算上下文预算。
 * 容量或 tokenizer 信息不可用时，继续使用字符预算。
 *
 * 1. ContextBudget 提供统一的大小计量、输入上限和输出预留，可选支持实际用量校准。
 * 2. createBudget 检查本地是否支持 o200k_base，再用用户窗口覆盖服务报告的窗口和输入容量，结合安全余量计算预算。
 * 3. 首次计量时加载编码器，计算完整请求的大小；observeUsage 根据服务返回的输入用量，
 *    必要时上调当前任务的估算比例。
 *
 * 累计用量不是当前上下文大小。源码中的特殊 token 字面量按普通文本处理，不能让编码器误当控制标记。
 */

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

/** 可结构化克隆到压缩 Worker 的计量配置；校准系数只在当前任务内上调。 */
export type ContextMeasurement =
  | { unit: "characters" }
  | { unit: "tokens"; tokenizer: "o200k_base"; correction: number };

export interface ContextBudget {
  unit: "tokens" | "characters";
  limit: number;
  measure: Measure;
  measurement: ContextMeasurement;
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

/** 使用服务明确返回、本地也支持的 tokenizer；不能根据模型名字猜编码。 */
/** 在调用线程计量完整请求；压缩 Worker 复用同一契约，不能改用不一致的字符近似。 */
export function measureContext(
  measurement: ContextMeasurement,
  input: any[],
  instructions: string,
  tools: any[],
): number {
  if (measurement.unit === "characters") {
    return contextSize(input, instructions, tools);
  }

  encoder ??= new Tiktoken(o200k);

  return Math.ceil(
    encoder.encode(JSON.stringify({ input, instructions, tools }), [], [])
      .length * measurement.correction,
  );
}

export function createBudget(
  capabilities: ModelCapabilities | undefined,
  fallbackChars: number,
  requestedOutput = 16384,
  maxContextTokens?: number,
): ContextBudget {
  if (!capabilities || capabilities.tokenizer !== "o200k_base") {
    const measurement: ContextMeasurement = { unit: "characters" };

    return {
      unit: "characters",
      limit: fallbackChars,
      measurement,
      measure: (input, instructions, tools) =>
        measureContext(measurement, input, instructions, tools),
    };
  }

  // 显式设置同时替代服务报告的上下文窗口与输入容量；不能把旧 max_prompt_tokens 再作为硬上限。
  const window =
    maxContextTokens ?? capabilities.limits.max_context_window_tokens;
  const safetyTokens = Math.max(1024, Math.ceil(window * 0.05));
  const outputTokens = Math.min(
    requestedOutput,
    capabilities.limits.max_output_tokens,
    Math.max(1, window - safetyTokens - 1024),
  );
  const limit =
    Math.min(
      window - outputTokens,
      maxContextTokens === undefined
        ? (capabilities.limits.max_prompt_tokens ?? window)
        : window,
    ) - safetyTokens;
  if (limit <= 0) {
    const measurement: ContextMeasurement = { unit: "characters" };

    return {
      unit: "characters",
      limit: fallbackChars,
      measurement,
      measure: (input, instructions, tools) =>
        measureContext(measurement, input, instructions, tools),
    };
  }

  const measurement: ContextMeasurement = {
    unit: "tokens",
    tokenizer: "o200k_base",
    correction: 1,
  };
  const rawMeasure: Measure = (input, instructions, tools) => {
    encoder ??= new Tiktoken(o200k);

    return encoder.encode(
      JSON.stringify({ input, instructions, tools }),
      [],
      [],
    ).length;
  };

  return {
    unit: "tokens",
    limit,
    measurement,
    outputTokens,
    contextWindowTokens: window,
    safetyTokens,
    tokenizer: capabilities.tokenizer,
    // 本地无法精确计算服务端的额外开销。源码里的特殊 token 字面量按普通文本计数。
    measure: (input, instructions, tools) =>
      measureContext(measurement, input, instructions, tools),
    // 只上调当前任务的估算比例，不能因为一次用量较低就减少预留。
    observeUsage: (actualInput, input, instructions, tools) => {
      measurement.correction = Math.max(
        measurement.correction,
        actualInput / Math.max(1, rawMeasure(input, instructions, tools)),
      );
    },
  };
}
