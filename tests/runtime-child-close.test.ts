/**
 * 用受控子进程事件验证 Runtime 测试夹具的关闭竞态，不启动额外 OS 进程。
 * 1. childFixture 保留真实流和 EventEmitter，只替代 kill，精确控制 exit/close 顺序。
 * 2. 覆盖提前信号退出、exit 后 stdio 尚未关闭、关闭幂等和不响应 EOF 的清理。
 * 3. 覆盖 spawn/stdin 错误、终止失败、退出后禁止再次 kill 与缺失关闭确认；不把未知清理标成成功。
 * 4. 假时钟仅推进清理安全期限；真实 Runtime/Worker 路径由集成测试继续覆盖。
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeChildClose } from "./fixtures/runtime-child-close.js";

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const close = createRuntimeChildClose(
    child as unknown as ChildProcessWithoutNullStreams,
  );

  return { child, close };
}

afterEach(() => vi.useRealTimers());

it("remembers a signal exit that happened before close was requested", async () => {
  const { child, close } = childFixture();
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  let result: string | undefined;
  void close().then((value) => {
    result = value;
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(result).toBe("orphaned");
  expect(child.kill).not.toHaveBeenCalled();
});

it("waits for stdio close rather than only process exit and shares cleanup", async () => {
  const { child, close } = childFixture();
  const closing = close();
  expect(close()).toBe(closing);
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  child.emit("exit", 0, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", 0, null);
  await expect(closing).resolves.toBe("clean");
});

it("terminates a fixture ignoring EOF but still waits for close confirmation", async () => {
  vi.useFakeTimers();
  const { child, close } = childFixture();
  const closing = close();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", null, "SIGKILL");
  await expect(closing).resolves.toBe("orphaned");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["process", "stdin"])(
  "retains %s failure even if close reports zero",
  async (source) => {
    const { child, close } = childFixture();
    const emitter = source === "process" ? child : child.stdin;
    emitter.emit("error", new Error("fixture failed"));
    child.emit("close", 0, null);

    await expect(close()).resolves.toBe("orphaned");
  },
);

it.each([false, true])(
  "rejects missing close confirmation with exited=%s",
  async (exited) => {
    vi.useFakeTimers();
    const { child, close } = childFixture();
    if (exited) {
      child.emit("exit", 0, null);
    }

    const closing = close();
    const rejected = expect(closing).rejects.toThrow("清理状态未知");
    await vi.advanceTimersByTimeAsync(7_000);
    await rejected;

    expect(child.kill).toHaveBeenCalledTimes(exited ? 0 : 1);
    expect(close()).toBe(closing);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("propagates a failed termination and removes its timers", async () => {
  vi.useFakeTimers();
  const { child, close } = childFixture();
  child.kill.mockImplementation(() => {
    throw new Error("kill failed");
  });
  const rejected = expect(close()).rejects.toThrow("kill failed");
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
