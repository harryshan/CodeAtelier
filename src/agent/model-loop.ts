/**
 * Engine 与 AgentRuntimeService 共用的模型轮次控制；具体 I/O 由两种入口提供。
 * 本模块只推进轮次与请求重试，不访问 Store、IPC、权限或工具执行器。
 *
 * 1. ModelLoopOperations 按准备、请求、保存响应、执行工具和完成的顺序声明适配入口。
 * 2. runModelLoop 在任务内只允许一次上下文超限恢复；普通重试沿用 retryModel，恢复后的 attempt 连续编号。
 * 3. 完整响应先交给 acceptResponse 保存，再判断结束或执行工具；保存和工具失败都直接向外传播，不进入模型重试。
 * 4. 返回值区分正常结束、工具执行后耗尽轮次、无效图后耗尽轮次，由入口保留现有的终态兼容规则。
 *
 * 各入口继续在实际 I/O 周围记录既有 tracing、事件、耗时和取消状态；共享控制本身不产生新的敏感 trace 属性。
 */

import type { ModelResult } from "../providers/model-provider.js";
import type { ModelError } from "../providers/model-error.js";
import { retryModel } from "../providers/retry.js";
import type { ModelToolCall } from "../tools/model-tool-batch.js";

interface ModelLoopOperations {
  maxSteps: number;
  signal: AbortSignal;
  prepareStep(step: number): Promise<void>;
  request(attempt: number): Promise<ModelResult>;
  onRetry(error: ModelError, failedAttempt: number, delayMs: number): void;
  prepareOverflow(): Promise<void>;
  acceptResponse(
    response: ModelResult,
    calls: ModelToolCall[],
  ): void | Promise<void>;
  executeTools(calls: ModelToolCall[]): Promise<"executed" | "invalid">;
  complete?(): void | Promise<void>;
}

export type ModelLoopOutcome =
  "completed" | "step-limit" | "invalid-batch-limit";

export async function runModelLoop(
  operations: ModelLoopOperations,
): Promise<ModelLoopOutcome> {
  let overflowRetried = false;
  let lastBatch: "executed" | "invalid" = "executed";

  for (let step = 1; step <= operations.maxSteps; step++) {
    operations.signal.throwIfAborted();
    await operations.prepareStep(step);

    let attempt = 0;
    let attemptOffset = 0;
    const requestModel = () =>
      retryModel(
        (currentAttempt) => {
          attempt = attemptOffset + currentAttempt;

          return operations.request(attempt);
        },
        operations.signal,
        operations.onRetry,
      );
    const response = await requestModel().catch(async (error) => {
      if (error?.code !== "context_length_exceeded" || overflowRetried) {
        throw error;
      }

      attemptOffset = attempt;
      overflowRetried = true;
      await operations.prepareOverflow();

      return requestModel();
    });
    const calls = response.output.filter(
      (item) => item.type === "function_call",
    );

    await operations.acceptResponse(response, calls);
    if (!calls.length) {
      if (!response.text) {
        throw new Error("模型未返回文本或工具调用。");
      }

      await operations.complete?.();

      return "completed";
    }

    lastBatch = await operations.executeTools(calls);
  }

  return lastBatch === "invalid" ? "invalid-batch-limit" : "step-limit";
}
