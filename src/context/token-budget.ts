/**
 * 根据服务返回的模型容量，为 Engine 和 ContextManager 计算上下文预算。
 * 容量或 tokenizer 信息不可用时，继续使用字符预算。
 *
 * 1. ContextBudget 提供统一的大小计量、输入上限和输出预留，可选支持实际用量校准。
 * 2. createBudget 检查本地是否支持 o200k_base，再用用户窗口覆盖服务报告的窗口和输入容量，结合安全余量计算预算。
 * 3. token 计量将固定请求部分与各历史项分别编码；任务级缓存复用稳定前缀，只编码新增项。
 * 4. observeUsage 将完整请求锚定到最新实报输入，后续仅估算追加项；重写历史或压缩后清除基线。
 * 5. measureContext 为 Worker 的新候选上下文提供纯本地计量，不将旧请求的实报值套在改写后的内容上。
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

/** Worker 只接收本地计量配置；实报基线仅属于主循环中未改写的请求。 */
export type ContextMeasurement =
  { unit: "characters" } | { unit: "tokens"; tokenizer: "o200k_base" };

export interface ContextBudget {
  unit: "tokens" | "characters";
  limit: number;
  measure: Measure;
  resetMeasurement?: () => void;
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
function tokenCount(text: string): number {
  encoder ??= new Tiktoken(o200k);

  return encoder.encode(text, [], []).length;
}

/** 每个协议项独立编码，使历史追加不必重新编码旧正文；边界合并仍属于本地估算误差。 */
function itemTokens(item: any, index: number): number {
  return tokenCount(
    (index === 0 ? "" : ",") + (JSON.stringify(item) ?? "null"),
  );
}

/** 主线程和压缩 Worker 使用同一分段计量口径；固定部分包括空 input 的 JSON 包装。 */
export function measureContext(
  measurement: ContextMeasurement,
  input: any[],
  instructions: string,
  tools: any[],
): number {
  if (measurement.unit === "characters") {
    return contextSize(input, instructions, tools);
  }

  let raw = tokenCount(JSON.stringify({ input: [], instructions, tools }));
  for (const [index, item] of input.entries()) {
    raw += itemTokens(item, index);
  }

  return raw;
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
  };
  let usageOffset = 0;
  let cache:
    | {
        input: any[];
        instructions: string;
        toolsJson: string;
        items: any[];
        raw: number;
      }
    | undefined;
  const rawMeasure: Measure = (input, instructions, tools) => {
    // Engine 与 Runtime 在同一任务中只追加历史项；其它数组或配置变化重建基线。
    // 检查所有旧项的身份，避免替换较早记录后沿用旧实报；旧对象内部的原位改写须主动 reset。
    const toolsJson = JSON.stringify(tools);
    const appendOnly =
      cache !== undefined &&
      cache.input === input &&
      cache.instructions === instructions &&
      cache.toolsJson === toolsJson &&
      input.length >= cache.items.length &&
      cache.items.every((item, index) => input[index] === item);
    if (!appendOnly) {
      usageOffset = 0;
    }

    let raw = appendOnly
      ? cache!.raw
      : tokenCount(JSON.stringify({ input: [], instructions, tools }));
    const start = appendOnly ? cache!.items.length : 0;
    const items = appendOnly ? cache!.items : [];
    for (let index = start; index < input.length; index++) {
      raw += itemTokens(input[index], index);
      items.push(input[index]);
    }

    cache = {
      input,
      instructions,
      toolsJson,
      items,
      raw,
    };

    return raw;
  };

  return {
    unit: "tokens",
    limit,
    measurement,
    outputTokens,
    contextWindowTokens: window,
    safetyTokens,
    tokenizer: capabilities.tokenizer,
    // offset = 上次实报 - 上次本地计量；旧前缀不变时等价于实报 + 新增项估算。
    measure: (input, instructions, tools) =>
      rawMeasure(input, instructions, tools) + usageOffset,
    resetMeasurement: () => {
      cache = undefined;
      usageOffset = 0;
    },
    // 仅使用当前请求的合法输入用量；最新实报可以向上或向下修正，不改变输出和安全预留。
    observeUsage: (actualInput, input, instructions, tools) => {
      if (!Number.isSafeInteger(actualInput) || actualInput < 0) {
        return;
      }

      usageOffset = actualInput - rawMeasure(input, instructions, tools);
    },
  };
}
