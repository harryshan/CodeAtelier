/**
 * 验证长工具的五分钟模型复查，不启动真实模型或 Evaluation。
 * 1. 使用虚拟时钟和可控 Promise 模拟持续运行、静默输出及完成/复查竞争。
 * 2. 核对 continue 不重放、stop 只取消当前调用并等待执行清理、故障不误杀。
 * 3. 验证尾部输出有界但持续更新，完成后取消在途检查并移除定时器。
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  monitorTool,
  TOOL_REVIEW_INTERVAL_MS,
  type ToolReview,
} from "../src/tools/long-tool-monitor.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });

  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

it("keeps parallel output and interruption isolated", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const finish = deferred<void>();
  const snapshots: string[] = [];
  const first = monitorTool(
    parent.signal,
    async (status) => {
      snapshots.push(status.latestOutput);

      return { action: "stop", reason: "first only" };
    },
    (signal, append) => {
      append("FIRST");

      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  );
  const second = monitorTool(
    parent.signal,
    async (status) => {
      snapshots.push(status.latestOutput);

      return { action: "continue", reason: "second alive" };
    },
    async (signal, append) => {
      append("SECOND");
      await finish.promise;
      signal.throwIfAborted();

      return "done";
    },
  );
  const failed = expect(first).rejects.toThrow("first only");
  await vi.advanceTimersByTimeAsync(TOOL_REVIEW_INTERVAL_MS);
  await failed;
  expect(snapshots).toEqual(["FIRST", "SECOND"]);
  expect(parent.signal.aborted).toBe(false);
  finish.resolve();
  await expect(second).resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);
});

it("checks every five minutes with the latest bounded output and never replays", async () => {
  vi.useFakeTimers();
  const done = deferred<string>();
  const review = vi.fn<ToolReview>(async () => ({
    action: "continue",
    reason: "仍在推进",
  }));
  let append!: (text: string) => void;
  const execute = vi.fn(
    async (_signal: AbortSignal, output: (text: string) => void) => {
      append = output;

      return done.promise;
    },
  );
  const result = monitorTool(new AbortController().signal, review, execute);
  append("old".repeat(10000));
  append("latest");
  await vi.advanceTimersByTimeAsync(TOOL_REVIEW_INTERVAL_MS - 1);
  expect(review).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(review.mock.calls[0]![0]).toMatchObject({
    elapsedMs: 300000,
    outputChars: 30006,
    outputTruncated: true,
  });
  expect((review.mock.calls[0]![0] as any).latestOutput).toHaveLength(12000);
  expect((review.mock.calls[0]![0] as any).latestOutput).toMatch(/latest$/);
  await vi.advanceTimersByTimeAsync(TOOL_REVIEW_INTERVAL_MS);
  expect(review).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(1);
  done.resolve("finished");
  await expect(result).resolves.toBe("finished");
  expect(vi.getTimerCount()).toBe(0);
});

it("stops only its own execution and waits for cleanup", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const cleaned = deferred<void>();
  let executionSignal!: AbortSignal;
  const result = monitorTool(
    parent.signal,
    async () => ({ action: "stop", reason: "已卡死" }),
    async (signal) => {
      executionSignal = signal;
      await cleaned.promise;
      signal.throwIfAborted();
    },
  );
  const rejected = expect(result).rejects.toThrow("已卡死");
  await vi.advanceTimersByTimeAsync(TOOL_REVIEW_INTERVAL_MS);
  expect(executionSignal.aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
  cleaned.resolve();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("does not overlap checks or apply a late stop after completion", async () => {
  vi.useFakeTimers();
  const done = deferred<number>();
  const decision = deferred<{ action: "stop"; reason: string }>();
  const review = vi.fn(() => decision.promise);
  let executionSignal!: AbortSignal;
  const result = monitorTool(
    new AbortController().signal,
    review,
    async (signal) => {
      executionSignal = signal;

      return done.promise;
    },
  );
  await vi.advanceTimersByTimeAsync(TOOL_REVIEW_INTERVAL_MS * 3);
  expect(review).toHaveBeenCalledTimes(1);
  done.resolve(42);
  await expect(result).resolves.toBe(42);
  decision.resolve({ action: "stop", reason: "过期判断" });
  await Promise.resolve();
  expect(executionSignal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("continues after review failure and stops reviewing after user cancellation", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const done = deferred<void>();
  const review = vi.fn(async () => {
    throw new Error("model offline");
  });
  const result = monitorTool(parent.signal, review, async (signal) => {
    await done.promise;
    signal.throwIfAborted();
  });
  const rejected = expect(result).rejects.toThrow("user cancelled");
  await vi.advanceTimersByTimeAsync(TOOL_REVIEW_INTERVAL_MS * 2);
  expect(review).toHaveBeenCalledTimes(2);
  parent.abort(new Error("user cancelled"));
  await vi.advanceTimersByTimeAsync(TOOL_REVIEW_INTERVAL_MS);
  expect(review).toHaveBeenCalledTimes(2);
  done.resolve();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
