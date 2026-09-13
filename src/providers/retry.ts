/**
 * 为 Engine 和摘要请求提供次数有限、可以取消的模型重试。
 * 调用方传入一次请求的函数，retryModel 返回成功结果，或将最终错误抛回调用方。
 *
 * 1. 执行请求，失败后用 modelError 判断是否属于可重试错误。
 * 2. 重试前通知调用方错误、次数和等待时间，再等待一段可取消的退避时间。
 * 3. 达到上限、遇到不可重试错误或收到取消信号时停止。
 *
 * 传入的操作只能是模型请求，不能包含工具执行，否则一次网络重试就可能重复修改文件或运行命令。
 */

import { setTimeout as delay } from "node:timers/promises";
import { ModelError, modelError } from "./model-error.js";

/** 这里只重试模型请求，不能把文件修改或命令执行放进来。 */
export async function retryModel<T>(
  run: (attempt: number) => Promise<T>,
  signal: AbortSignal,
  onRetry: (error: ModelError, attempt: number, delayMs: number) => void,
  options = { retries: 2, baseDelayMs: 1000 },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await run(attempt);
    } catch (error) {
      signal.throwIfAborted();
      const failure = modelError(error);

      if (!failure.retryable || attempt > options.retries) {
        throw failure;
      }

      // 优先按服务端建议等待，但本地仍设上限，避免一直等下去。
      const wait = Math.min(
        30000,
        Math.max(
          0,
          failure.retryAfterMs || 0,
          options.baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2),
        ),
      );

      onRetry(failure, attempt, Math.round(wait));
      await delay(wait, undefined, { signal });
    }
  }
}
