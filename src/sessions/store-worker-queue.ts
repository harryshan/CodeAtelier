/**
 * 串行调度 Store 的 SQLite Worker 请求；Store 是唯一调用方，Worker 独占后台写连接。
 * 1. request 为每项工作分配单调 ID，限制等待队列，并按提交顺序逐条发送；不在失败后重试未知写入。
 * 2. 消息回执才完成 Promise；Worker 崩溃会拒绝当前和排队请求，阻止继续写入。
 * 3. close 等待已提交请求的结果后释放线程；trace 的排队和执行分别占独立轨道，不记录 SQL 参数。
 */

import { Worker } from "node:worker_threads";
import type { TraceRecorder } from "../tracing/recorder.js";
import type {
  StoreWorkerRequest,
  StoreWorkerResponse,
} from "./store-worker.js";

interface Pending {
  request: StoreWorkerRequest;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  queued: ReturnType<TraceRecorder["startSpan"]>;
  running?: ReturnType<TraceRecorder["startSpan"]>;
}

export class StoreWorkerQueue {
  private worker?: Worker;
  private readonly pending: Pending[] = [];
  private current?: Pending;
  private nextId = 1;
  private error?: Error;
  private closing = false;
  private idle: Array<() => void> = [];

  constructor(private traces?: TraceRecorder) {}

  setTracer(traces: TraceRecorder) {
    this.traces = traces;
  }

  request<T>(request: Omit<StoreWorkerRequest, "id">): Promise<T> {
    if (this.closing || this.error) {
      return Promise.reject(this.error ?? new Error("Store 已关闭。"));
    }

    if (this.pending.length >= 1024) {
      return Promise.reject(new Error("Store 写入队列已满。"));
    }

    const item: StoreWorkerRequest = { ...request, id: this.nextId++ };

    return new Promise<T>((resolve, reject) => {
      const queued = this.traces?.startSpan(request.taskId ?? "", {
        name: "store.queue",
        category: "storage",
        track: "Store queue",
        attributes: { operation: request.operation },
      });
      this.pending.push({
        request: item,
        resolve: (value) => resolve(value as T),
        reject,
        queued,
      });
      this.dispatch();
    });
  }

  async drain() {
    if (!this.current && this.pending.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  async close() {
    this.closing = true;
    await this.drain();
    if (this.worker) {
      const worker = this.worker;
      this.worker = undefined;
      await worker.terminate();
    }
  }

  private dispatch() {
    if (this.current || this.error) {
      return;
    }

    const next = this.pending.shift();
    if (!next) {
      this.worker?.unref();
      for (const resolve of this.idle.splice(0)) {
        resolve();
      }

      return;
    }

    this.current = next;
    this.traces?.endSpan(next.queued, "ok");
    next.running = this.traces?.startSpan(next.request.taskId ?? "", {
      name: `store.${next.request.operation}`,
      category: "storage",
      track: "Store worker",
      attributes: {
        requestId: next.request.id,
        operation: next.request.operation,
      },
    });
    try {
      if (!this.worker) {
        const source = import.meta.url.endsWith(".ts")
          ? new URL("./store-worker.ts", import.meta.url)
          : new URL("./store-worker.js", import.meta.url);
        this.worker = new Worker(source, {
          execArgv: source.pathname.endsWith(".ts")
            ? ["--import", "tsx"]
            : undefined,
        });
        this.worker.on("message", (message: StoreWorkerResponse) =>
          this.receive(message),
        );
        this.worker.on("error", (error) => this.fail(error));
        this.worker.on("exit", (code) => {
          if (this.worker && !this.error) {
            this.fail(new Error(`Store Worker 意外退出 (${code})；结果未知。`));
          }
        });
      }

      this.worker.ref();
      this.worker.postMessage(next.request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private receive(message: StoreWorkerResponse) {
    const current = this.current;
    if (!current || message.id !== current.request.id) {
      this.fail(new Error("Store Worker 回执 ID 不匹配，写入结果未知。"));

      return;
    }

    this.current = undefined;
    this.traces?.endSpan(current.running, message.ok ? "ok" : "error", {
      errorName: message.ok ? undefined : "StoreWorkerError",
    });
    if (message.ok) {
      current.resolve(message.value);
    } else {
      current.reject(new Error(message.error ?? "Store Worker 写入失败。"));
    }

    this.dispatch();
  }

  private fail(error: Error) {
    if (this.error) {
      return;
    }

    this.error = error;
    this.worker?.unref();
    const jobs = [this.current, ...this.pending].filter(
      (item): item is Pending => Boolean(item),
    );
    this.current = undefined;
    this.pending.length = 0;
    for (const job of jobs) {
      this.traces?.endSpan(job.queued, "error", { errorName: error.name });
      this.traces?.endSpan(job.running, "error", { errorName: error.name });
      job.reject(error);
    }

    for (const resolve of this.idle.splice(0)) {
      resolve();
    }
  }
}
