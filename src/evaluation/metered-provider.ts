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
    try {
      const result = await this.provider.run(...args);
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
      this.checkpoint();
    }
  }
}
