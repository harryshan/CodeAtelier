/**
 * 管理一次上下文压缩专用 Worker 的消息与取消生命周期。
 * ContextManager 在达到阈值后创建此客户端，依次请求 prepare、transform、可选 chunks 和 finalize，
 * 再由主线程执行文件哈希探测、摘要模型调用与 SQLite 提交。
 *
 * 1. 构造器按开发/构建后的模块扩展名启动 compaction-worker，并为每条消息分配递增 ID。
 * 2. request 将 Worker 成功值或受控错误转换为 Promise；AbortSignal 会立即终止线程，避免取消后继续占用 CPU。
 * 3. close 清理尚未完成的请求并结束线程。客户端不保存历史、不会重试模型，也不访问 SQLite。
 *
 * Worker 返回的数据只是历史处理结果；调用方仍须在提交前检查取消，并遵守文件访问和恢复边界。
 */

import { Worker } from "node:worker_threads";

interface WorkerMessage {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class CompactionWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor() {
    const source = import.meta.url.endsWith(".ts")
      ? new URL("./compaction-worker.ts", import.meta.url)
      : new URL("./compaction-worker.js", import.meta.url);
    this.worker = new Worker(source, {
      execArgv: source.pathname.endsWith(".ts")
        ? ["--import", "tsx"]
        : undefined,
    });
    this.worker.unref();
    this.worker.on("message", (message: WorkerMessage) => {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.value);
      } else {
        pending.reject(new Error(message.error || "压缩 Worker 执行失败。"));
      }
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.fail(new Error(`压缩 Worker 意外退出（${code}）。`));
      }
    });
  }

  /** 发送一项串行压缩操作；取消必须释放 Worker，而不能等它完成大型字符串处理。 */
  request<T>(type: string, data: unknown, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.closed) {
      return Promise.reject(new Error("压缩 Worker 已关闭。"));
    }

    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        void this.close();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("任务已取消。"),
        );
      };

      const complete = (value: unknown) => {
        signal.removeEventListener("abort", abort);
        resolve(value as T);
      };

      const fail = (error: Error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      };

      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: complete, reject: fail });
      this.worker.postMessage({ id, type, data });
    });
  }

  /** 结束本次压缩线程；每项压缩独占状态，绝不能被下一任务复用。 */
  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const error = new Error("压缩 Worker 已关闭。");
    this.fail(error);
    await this.worker.terminate();
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();
  }
}
