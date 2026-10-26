/**
 * 异常 Local 私有层检查的原生租约客户端，供 interrupted-review 的只读事务使用。
 * 1. withLocalInspection 启动固定 helper，等待旧进程退出/控制目录排他证明；无重试或锁删除。
 * 2. 生命周期取消或 helper 异常退出中止回调信号，回调排空后才关闭租约；不竞速返回成功。
 * 3. 只接受 ready/closed 两种有界收据，结束等待 close；超时终止自己创建的 helper 并等待确认。
 * 不挂载、修复或写来源；外层恢复操作负责 ID、耗时、失败/取消日志及 tracing。
 */
import { spawn } from "node:child_process";
import { overlayHelperPath } from "../local-overlays/winfsp-manager.js";
import { PublishError } from "./publication/merge.js";

export async function withLocalInspection<T>(
  control: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (process.platform !== "win32") {
    throw new PublishError("WINDOWS_REQUIRED");
  }

  const child = spawn(overlayHelperPath(), ["inspect-local", control], {
    windowsHide: true,
    stdio: "pipe",
  });
  const lifetime = new AbortController();
  const current = AbortSignal.any([signal, lifetime.signal]);
  let pending:
    { resolve: () => void; reject: (error: Error) => void } | undefined;
  let expected = "local-inspection-ready";
  let buffer = "";
  let closedReceipt = false;
  const fail = () => {
    const error = new PublishError("LOCAL_INSPECTION_UNCONFIRMED");
    lifetime.abort(error);
    pending?.reject(error);
    pending = undefined;
  };

  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    buffer += text;
    if (buffer.length > 4096) {
      fail();
      child.kill();

      return;
    }

    const end = buffer.indexOf("\n");
    if (end < 0) {
      return;
    }

    try {
      const reply = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (
        !pending ||
        buffer.length ||
        reply.version !== 1 ||
        reply.state !== expected ||
        reply.error
      ) {
        throw new Error("Invalid inspection reply");
      }

      closedReceipt = expected === "local-inspection-closed";
      const request = pending;
      pending = undefined;
      request.resolve();
    } catch {
      fail();
      child.kill();
    }
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      if (!closedReceipt || code !== 0) {
        fail();
      }

      resolve(code);
    });
  });
  const request = async (stop: boolean) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      fail();
      child.kill();
    };

    try {
      if (lifetime.signal.aborted) {
        throw lifetime.signal.reason;
      }

      if (!stop) {
        signal.throwIfAborted();
      }

      await new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        timer = setTimeout(cancel, 15_000);
        if (stop) {
          expected = "local-inspection-closed";
          child.stdin.end("stop\n");
        } else {
          signal.addEventListener("abort", cancel, { once: true });
        }
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  };

  try {
    await request(false);
    const result = await operation(current);
    current.throwIfAborted();

    return result;
  } finally {
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await request(true);
      exitTimer = setTimeout(() => child.kill(), 15_000);
      if ((await exited) !== 0) {
        throw new PublishError("LOCAL_INSPECTION_UNCONFIRMED");
      }
    } catch (error) {
      child.kill();
      await exited;
      throw error;
    } finally {
      clearTimeout(exitTimer);
    }
  }
}
