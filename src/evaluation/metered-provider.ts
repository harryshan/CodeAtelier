/**
 * 文件作用：为评测包装生产模型接口，累计实际用量并限制调用预算。
 *
 * 模块协作与输入输出：
 * 包装任意 ModelProvider，Engine 的主任务、摘要和重试均经过同一计量实例。
 *
 * 代码结构与执行顺序：
 * 1. EvaluationUsage 区分已计量与未知调用，timings 保存首段文本和总耗时。
 * 2. getCapabilities 透明转发可选能力查询；run 在调用前检查未知用量、累计 token 和次数限制。
 * 3. 发请求前先登记未知用量并 checkpoint，成功收到有效 usage 后再转为已计量。
 * 4. 包装 onDelta 记录首次文本时间，finally 无论成功失败都保存耗时与 checkpoint。
 *
 * 关键约束：
 * 预算是下一次调用前的停止门槛，单次调用可能越过累计阈值；缺失 usage 不能当成零消耗。
 */

import type {
  ModelProvider,
  ModelResult,
} from "../providers/model-provider.js";
import { parseUsage } from "../providers/model-metadata.js";
import { ModelError } from "../providers/model-error.js";

export interface EvaluationUsage {
  calls: number;
  measuredCalls: number;
  unmeasuredCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cachedUsageComplete: boolean;
}

/** Wrap all model calls, including compaction and retries, without changing Engine. */
export class MeteredProvider implements ModelProvider {
  readonly usage: EvaluationUsage = {
    calls: 0,
    measuredCalls: 0,
    unmeasuredCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cachedUsageComplete: true,
  };

  readonly timings: {
    durationMs: number;
    firstDeltaMs: number | null;
    failed: boolean;
  }[] = [];

  stopReason?: "token_budget" | "call_budget" | "usage_unavailable";

  constructor(
    private provider: ModelProvider,
    private limits: { maxTotalTokens: number; maxModelCalls: number },
    private checkpoint: () => void,
  ) {}

  getCapabilities(signal: AbortSignal) {
    return (
      this.provider.getCapabilities?.(signal) ?? Promise.resolve(undefined)
    );
  }

  async run(...args: Parameters<ModelProvider["run"]>): Promise<ModelResult> {
    if (this.usage.unmeasuredCalls) {
      this.stopReason = "usage_unavailable";
    } else if (this.usage.totalTokens >= this.limits.maxTotalTokens) {
      this.stopReason = "token_budget";
    } else if (this.usage.calls >= this.limits.maxModelCalls) {
      this.stopReason = "call_budget";
    }

    if (this.stopReason) {
      this.checkpoint();
      throw new ModelError(
        `Evaluation stopped: ${this.stopReason}`,
        false,
        this.stopReason,
      );
    }

    this.usage.calls++;
    // Count an in-flight/failed request as unknown until a valid response arrives.
    this.usage.unmeasuredCalls++;
    this.checkpoint();
    const started = performance.now();
    let firstDeltaMs: number | null = null;
    let failed = true;
    const onDelta = args[4];
    args[4] = (text) => {
      if (text && firstDeltaMs === null) {
        firstDeltaMs = performance.now() - started;
      }

      onDelta(text);
    };

    try {
      const result = await this.provider.run(...args);
      failed = false;
      const usage = parseUsage(result.usage);
      if (usage) {
        this.usage.unmeasuredCalls--;
        this.usage.measuredCalls++;
        this.usage.inputTokens += usage.input_tokens;
        this.usage.outputTokens += usage.output_tokens;
        this.usage.totalTokens += usage.total_tokens;
        this.usage.cachedInputTokens +=
          usage.input_tokens_details?.cached_tokens ?? 0;
        this.usage.cachedUsageComplete &&=
          usage.input_tokens_details?.cached_tokens !== undefined;
      }

      return result;
    } finally {
      this.timings.push({
        durationMs: performance.now() - started,
        firstDeltaMs,
        failed,
      });
      this.checkpoint();
    }
  }
}
