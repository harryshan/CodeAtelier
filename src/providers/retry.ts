/**
 * 为 Engine 和摘要请求提供次数有限、可以取消的模型重试。
 * 调用方传入一次请求的函数，retryModel 返回成功结果，或将最终错误抛回调用方。
 *
 * 1. 执行请求，失败后用 modelError 判断是否属于可重试错误；调用方可选择重试无分类错误。
 * 2. 重试前通知调用方错误、次数和等待时间，再等待一段可取消的退避时间。
 * 3. 达到上限、遇到不可重试错误或收到取消信号时停止。
 *
 * 传入的操作只能是模型请求，不能包含工具执行，否则一次网络重试就可能重复修改文件或运行命令。
 */

import { setTimeout as delay } from "node:timers/promises";
import { ModelError, modelError } from "./model-error.js";

/** 控制有限重试次数、退避间隔及未知错误的降级策略。 */
export interface RetryOptions {
  /** 首次请求失败后允许的额外尝试次数。 */
  retries?: number;
  /** 首次重试前的基础等待时间；后续等待按指数增长。 */
  baseDelayMs?: number;
  /** 没有 HTTP 状态或协议错误码的通用 model_error 是否也可重试。 */
  retryUnknownErrors?: boolean;
}

const defaultOptions: Required<RetryOptions> = {
  retries: 2,
  baseDelayMs: 1000,
  retryUnknownErrors: false,
};

/** 这里只重试模型请求，不能把文件修改或命令执行放进来。 */
export async function retryModel<T>(
  run: (attempt: number) => Promise<T>,
  signal: AbortSignal,
  onRetry: (error: ModelError, attempt: number, delayMs: number) => void,
  options: RetryOptions = {},
): Promise<T> {
  const policy = { ...defaultOptions, ...options };

  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await run(attempt);
    } catch (error) {
      signal.throwIfAborted();
      const failure = modelError(error);

      const retryUnknownError =
        policy.retryUnknownErrors && failure.code === "model_error";
      if (
        (!failure.retryable && !retryUnknownError) ||
        attempt > policy.retries
      ) {
        throw failure;
      }

      // 优先按服务端建议等待，但本地仍设上限，避免一直等下去。
      const wait = Math.min(
        30000,
        Math.max(
          0,
          failure.retryAfterMs || 0,
          policy.baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2),
        ),
      );

      onRetry(failure, attempt, Math.round(wait));
      await delay(wait, undefined, { signal });
    }
  }
}
