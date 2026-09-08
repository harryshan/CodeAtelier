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
