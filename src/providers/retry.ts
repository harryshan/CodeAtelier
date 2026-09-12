/**
 * 文件作用：为模型调用提供有界、可取消的自动重试。
 *
 * 模块协作与输入输出：
 * 由 Engine 和摘要调用路径使用，将一次模型请求包装为有限次数的尝试。
 *
 * 代码结构与执行顺序：
 * 1. retryModel 调用传入操作，失败后通过 modelError 判断是否允许重试。
 * 2. 重试前通知调用方当前错误、次数及等待时长，再执行可取消的退避。
 * 3. 达到次数上限、永久错误或取消时把失败交回调用方。
 *
 * 关键约束：
 * 仅重试传入的模型操作，不包含工具副作用；通知和取消不能额外触发一次请求。
 */

import { setTimeout as delay } from "node:timers/promises";
import { ModelError, modelError } from "./model-error.js";

/** 仅重试模型请求，工具副作用不能进入这个重试循环。 */
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

      // 优先参考服务端退避提示，同时限制本地等待时间，避免无界重试。
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
