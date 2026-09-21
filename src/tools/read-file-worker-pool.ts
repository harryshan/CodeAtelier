/**
 * 维护一个任务内共享、最多四条的 read_file CPU Worker 池。
 * ToolRunner 在主线程完成路径解析、权限审批、普通文件/大小检查和异步 readFile 后调用 process；本池只传递 ArrayBuffer 给
 * read-file-worker，不提供路径、命令或其它进程能力。forCall 共享同一池，使同一 DAG 批次的独立读取可同时占用不同 Worker。
 *
 * 1. ReadFileWorkerPool.process 将调用排入有界槽位，并把可转移的完整字节缓冲区发送给空闲 Worker。
 * 2. startWorker 按 ts/js/mjs 运行形态选择同名 Worker 文件，支持开发 tsx、常规构建和 Windows 安装版 bundle。
 * 3. AbortSignal 会移除未开始请求或终止正在计算的槽位；空闲短暂保留以复用同一任务的后续批次，随后只终止空闲线程而不关闭池，因此同一长任务的下一轮读取仍可按需新建线程。
 *
 * Worker 的结果没有副作用；取消只会丢弃尚未返回的计算结果，ToolRunner 仍负责文件版本凭证与任务恢复语义。
 */

import { Worker } from "node:worker_threads";

export interface ReadFileWorkerResult {
  contentHash: string;
  totalLines: number;
  returnedEndLine: number;
  truncated: boolean;
  hasMore: boolean;
  nextStartLine: number | null;
  text: string;
  visibleText?: string;
}

interface PendingRequest {
  id: number;
  buffer: ArrayBuffer;
  startLine: number;
  endLine: number;
  maxLines: number;
  whitespaceMode: boolean;
  signal: AbortSignal;
  resolve: (value: ReadFileWorkerResult) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

interface WorkerMessage {
  id: number;
  ok: boolean;
  value?: ReadFileWorkerResult;
  error?: string;
}

interface WorkerSlot {
  worker: Worker;
  current?: PendingRequest;
}

const MAX_READ_FILE_WORKERS = 4;
const IDLE_TIMEOUT_MS = 1_000;

function workerSource() {
  if (import.meta.url.endsWith(".ts")) {
    return new URL("./read-file-worker.ts", import.meta.url);
  }

  if (import.meta.url.endsWith(".mjs")) {
    return new URL("./read-file-worker.mjs", import.meta.url);
  }

  return new URL("./read-file-worker.js", import.meta.url);
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("任务已取消。");
}

export class ReadFileWorkerPool {
  private readonly slots = new Set<WorkerSlot>();
  private readonly queue: PendingRequest[] = [];
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  process(
    buffer: ArrayBuffer,
    options: {
      startLine: number;
      endLine: number;
      maxLines: number;
      whitespaceMode: boolean;
    },
    signal: AbortSignal,
  ): Promise<ReadFileWorkerResult> {
    signal.throwIfAborted();
    if (this.closed) {
      return Promise.reject(new Error("读取 Worker 池已关闭。"));
    }

    this.clearIdleTimer();

    return new Promise<ReadFileWorkerResult>((resolve, reject) => {
      const request: PendingRequest = {
        id: this.nextId++,
        buffer,
        ...options,
        signal,
        resolve,
        reject,
        abort: () => {
          this.cancel(request, abortError(signal));
        },
      };
      signal.addEventListener("abort", request.abort, { once: true });
      this.queue.push(request);
      this.dispatch();
    });
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.clearIdleTimer();
    const error = new Error("读取 Worker 池已关闭。");
    for (const request of this.queue.splice(0)) {
      this.complete(request, error);
    }

    const slots = [...this.slots];
    this.slots.clear();
    await Promise.all(slots.map((slot) => this.stopSlot(slot, error)));
  }

  private dispatch() {
    if (this.closed) {
      return;
    }

    for (const slot of this.slots) {
      if (!this.queue.length) {
        break;
      }

      if (!slot.current) {
        this.start(slot, this.queue.shift()!);
      }
    }

    while (this.queue.length && this.slots.size < MAX_READ_FILE_WORKERS) {
      const slot = this.startWorker();
      this.start(slot, this.queue.shift()!);
    }

    if (!this.queue.length && [...this.slots].every((slot) => !slot.current)) {
      this.scheduleIdleWorkerRelease();
    }
  }

  private startWorker() {
    const source = workerSource();
    const worker = new Worker(source, {
      execArgv: source.pathname.endsWith(".ts")
        ? ["--import", "tsx"]
        : undefined,
    });
    const slot: WorkerSlot = { worker };

    worker.unref();
    worker.on("message", (message: WorkerMessage) =>
      this.onMessage(slot, message),
    );
    worker.on("error", (error) => this.onWorkerFailure(slot, error));
    worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.onWorkerFailure(
          slot,
          new Error(`读取 Worker 意外退出（${code}）。`),
        );
      }
    });
    this.slots.add(slot);

    return slot;
  }

  private start(slot: WorkerSlot, request: PendingRequest) {
    slot.current = request;
    slot.worker.postMessage(
      {
        id: request.id,
        type: "read",
        data: {
          bytes: request.buffer,
          startLine: request.startLine,
          endLine: request.endLine,
          maxLines: request.maxLines,
          whitespaceMode: request.whitespaceMode,
        },
      },
      [request.buffer],
    );
  }

  private onMessage(slot: WorkerSlot, message: WorkerMessage) {
    const request = slot.current;
    if (!request || request.id !== message.id) {
      return;
    }

    slot.current = undefined;
    this.complete(
      request,
      message.ok
        ? undefined
        : new Error(message.error || "读取 Worker 执行失败。"),
      message.value,
    );
    this.dispatch();
  }

  private onWorkerFailure(slot: WorkerSlot, error: Error) {
    if (!this.slots.delete(slot)) {
      return;
    }

    const request = slot.current;
    slot.current = undefined;
    if (request) {
      this.complete(request, error);
    }

    this.dispatch();
  }

  private cancel(request: PendingRequest, error: Error) {
    const queuedIndex = this.queue.indexOf(request);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.complete(request, error);
      this.dispatch();

      return;
    }

    const slot = [...this.slots].find(
      (candidate) => candidate.current === request,
    );
    if (!slot) {
      return;
    }

    this.slots.delete(slot);
    slot.current = undefined;
    this.complete(request, error);
    void this.stopSlot(slot, error).finally(() => this.dispatch());
  }

  private complete(
    request: PendingRequest,
    error?: Error,
    value?: ReadFileWorkerResult,
  ) {
    request.signal.removeEventListener("abort", request.abort);
    if (error) {
      request.reject(error);
    } else if (value) {
      request.resolve(value);
    } else {
      request.reject(new Error("读取 Worker 未返回结果。"));
    }
  }

  private async stopSlot(slot: WorkerSlot, error: Error) {
    const request = slot.current;
    slot.current = undefined;
    if (request) {
      this.complete(request, error);
    }

    await slot.worker.terminate();
  }

  private scheduleIdleWorkerRelease() {
    if (this.idleTimer || this.closed) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.releaseIdleWorkers();
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private async releaseIdleWorkers() {
    if (
      this.closed ||
      this.queue.length ||
      [...this.slots].some((slot) => slot.current)
    ) {
      return;
    }

    const slots = [...this.slots];
    this.slots.clear();
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
