/**
 * 为手动评测统计模型用量和耗时，并在下一次请求前检查总预算。
 * 它包装 ModelProvider，主任务、摘要和重试共用同一份计量状态。
 *
 * 1. EvaluationUsage 分开记录已知和未知用量；timings 保存首次文本和整次调用耗时。
 * 2. forProvider 给辅助模型创建共享计量的包装；能力查询仍转发给对应模型。
 * 3. run/runWithProvider 发请求前检查预算，先将本次调用记为用量未知并保存检查点，
 *    收到合法 usage 后再更新为已知用量。
 * 4. onDelta 记录首次文本时间；无论成功还是失败，finally 都保存耗时和检查点。
 *
 * 检查只能阻止下一次调用，当前请求仍可能让总用量超过上限。服务没返回 usage 时不能按零计算。
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

/** 在模型接口外统计全部调用，包括摘要和重试，不必修改 Engine。 */
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

  /** 辅助模型沿用同一份计数，和主任务共用总预算及未知用量记录。 */
  forProvider(provider: ModelProvider): ModelProvider {
    return {
      getCapabilities: (signal) =>
        provider.getCapabilities?.(signal) ?? Promise.resolve(undefined),
      run: (...args) => this.runWithProvider(provider, ...args),
    };
  }

  async run(...args: Parameters<ModelProvider["run"]>): Promise<ModelResult> {
    return this.runWithProvider(this.provider, ...args);
  }

  private async runWithProvider(
    provider: ModelProvider,
    ...args: Parameters<ModelProvider["run"]>
  ): Promise<ModelResult> {
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
    // 请求发出后可能已产生费用；拿到有效 usage 前，进行中或失败的请求都记为用量未知。
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
      const result = await provider.run(...args);
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
