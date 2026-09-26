/**
 * 连接层的增量事件统计，供 SessionViewModel 在 SSE 批次到达时调用。
 * 1. EventStatisticsSnapshot 发布 token、模型轮次、工具结果和任务结束时间，不包含正文。
 * 2. SessionEventStatistics.append 处理单个去重事件；usage 兼容统计在首个 request 到达时撤销。
 * 3. snapshot 返回独立计数和结束时间索引；旧发布结果不受后续事件影响。
 * 不处理当前时钟或任务状态；这两项由 session-statistics 在快照更新时编译。
 */

import type { Event } from "../shared/types";
import type { ModelPurpose } from "./session-statistics";

function purposes(): Record<ModelPurpose, number> {
  return { task: 0, compaction: 0, title: 0, approval: 0, subagent: 0 };
}

function purpose(value: unknown): ModelPurpose {
  return value === "compaction" ||
    value === "title" ||
    value === "approval" ||
    value === "subagent"
    ? value
    : "task";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export interface EventStatisticsSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  cacheDetailsComplete: boolean;
  modelRequestsByPurpose: Record<ModelPurpose, number>;
  llmRequests: number;
  llmRounds: number;
  toolCalls: number;
  completedToolCalls: number;
  successfulToolCalls: number;
  pendingToolCalls: number;
  toolSuccessRate?: number;
  toolCallsByName: Record<string, number>;
  endTimes: Map<string, number>;
}

export class SessionEventStatistics {
  private input = 0;
  private output = 0;
  private total = 0;
  private cached = 0;
  private usages = 0;
  private missingCache = false;
  private requests = purposes();
  private requestTasks = new Set<string>();
  private rounds = new Set<string>();
  private legacy = new Map<
    string,
    { requests: Record<ModelPurpose, number>; rounds: Set<string> }
  >();

  private legacyRounds = 0;
  private tools = 0;
  private results = 0;
  private successful = 0;
  private names = new Map<string, number>();
  private ends = new Map<string, number>();
  private saved?: EventStatisticsSnapshot;

  append(event: Event) {
    if (
      ![
        "model_request",
        "model_usage",
        "tool_start",
        "tool_result",
        "task_end",
      ].includes(event.type)
    ) {
      return;
    }

    this.saved = undefined;
    const data = event.data;
    if (event.type === "model_request") {
      const old = this.legacy.get(event.taskId);
      if (old) {
        for (const key of Object.keys(this.requests) as ModelPurpose[]) {
          this.requests[key] -= old.requests[key];
        }

        this.legacyRounds -= old.rounds.size;
        this.legacy.delete(event.taskId);
      }

      this.requestTasks.add(event.taskId);
      const category = purpose(data?.purpose);
      this.requests[category]++;
      if (category === "task") {
        this.rounds.add(
          JSON.stringify([event.taskId, number(data?.step) ?? event.id]),
        );
      }
    } else if (event.type === "model_usage") {
      this.usages++;
      const input = number(data?.input_tokens);
      const output = number(data?.output_tokens);
      const total = number(data?.total_tokens);
      if (input === undefined || output === undefined || total === undefined) {
        return;
      }

      this.input += input;
      this.output += output;
      this.total += total;
      const cached = number(data?.input_tokens_details?.cached_tokens);
      this.missingCache ||= cached === undefined;
      this.cached += cached ?? 0;
      if (!this.requestTasks.has(event.taskId)) {
        const old = this.legacy.get(event.taskId) ?? {
          requests: purposes(),
          rounds: new Set<string>(),
        };
        const category = purpose(data?.purpose);
        old.requests[category]++;
        this.requests[category]++;
        if (category === "task") {
          const key = String(number(data?.step) ?? event.id);
          if (!old.rounds.has(key)) {
            old.rounds.add(key);
            this.legacyRounds++;
          }
        }

        this.legacy.set(event.taskId, old);
      }
    } else if (event.type === "tool_start") {
      this.tools++;
      const name = typeof data?.name === "string" ? data.name : "未知工具";
      this.names.set(name, (this.names.get(name) ?? 0) + 1);
    } else if (event.type === "tool_result") {
      this.results++;
      if (
        !data?.result?.error &&
        (data?.result?.exitCode === undefined || data.result.exitCode === 0)
      ) {
        this.successful++;
      }
    } else {
      const endedAt = Date.parse(event.createdAt);
      if (Number.isFinite(endedAt)) {
        this.ends.set(event.taskId, endedAt);
      }
    }
  }

  snapshot(): EventStatisticsSnapshot {
    if (this.saved) {
      return this.saved;
    }

    const complete = this.usages > 0 && !this.missingCache;
    this.saved = {
      inputTokens: this.input,
      outputTokens: this.output,
      totalTokens: this.total,
      cachedInputTokens: complete ? this.cached : undefined,
      uncachedInputTokens: complete ? this.input - this.cached : undefined,
      cacheDetailsComplete: complete,
      modelRequestsByPurpose: { ...this.requests },
      llmRequests: Object.values(this.requests).reduce(
        (sum, value) => sum + value,
        0,
      ),
      llmRounds: this.rounds.size + this.legacyRounds,
      toolCalls: this.tools,
      completedToolCalls: this.results,
      successfulToolCalls: this.successful,
      pendingToolCalls: Math.max(0, this.tools - this.results),
      toolSuccessRate: this.results
        ? this.successful / this.results
        : undefined,
      toolCallsByName: Object.fromEntries(this.names),
      endTimes: new Map(this.ends),
    };

    return this.saved;
  }
}
