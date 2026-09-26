/**
 * 维护一个任务内共享、最多四条的 read_file CPU Worker 池。
 * ToolRunner 在主线程完成路径解析、权限审批、普通文件/大小检查和异步 readFile 后调用 process；本池只传递 ArrayBuffer 给
 * read-file-worker，不提供路径、命令或其它进程能力。forCall 共享同一池，使同一 DAG 批次的独立读取可同时占用不同 Worker。
 *
 * 1. ReadFileWorkerPool.process 将调用排入有界槽位，按请求上报排队、Worker 冷启动与响应阶段，并把可转移的完整字节缓冲区发送给空闲 Worker；响应仅附带 Worker 的计算耗时，不额外创建计算轨道。
 * 2. startWorker 按 ts/js/mjs 运行形态选择同名 Worker 文件，支持开发 tsx、常规构建和 Windows 安装版 bundle。
 * 3. AbortSignal 会移除未开始请求或终止正在计算的槽位；已创建线程在任务内保持可复用，close 同时等待正常线程和取消中尚未退出的线程。
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

export type ReadFileTraceStage =
  | "read_file.stat"
  | "read_file.bytes"
  | "read_file.worker.queue"
  | "read_file.worker.startup"
  | "read_file.worker.response";

export type ReadFileTrace = (
  stage: ReadFileTraceStage,
  state: "started" | "ok" | "error" | "cancelled",
  details?: {
    bytes?: number;
    computeMs?: number;
  },
) => void;

interface PendingRequest {
  id: number;
  phase: "queue" | "startup" | "response";
  trace?: ReadFileTrace;
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
  type?: "ready";
  id?: number;
  ok?: boolean;
  computeMs?: number;
  value?: ReadFileWorkerResult;
  error?: string;
}

interface WorkerSlot {
  worker: Worker;
  ready: boolean;
  current?: PendingRequest;
}

const MAX_READ_FILE_WORKERS = 4;

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
  private readonly stopping = new Set<Promise<void>>();
  private closePromise?: Promise<void>;
  private stopFailure?: Error;
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
    trace?: ReadFileTrace,
  ): Promise<ReadFileWorkerResult> {
    signal.throwIfAborted();
    if (this.closed) {
      return Promise.reject(new Error("读取 Worker 池已关闭。"));
    }

    return new Promise<ReadFileWorkerResult>((resolve, reject) => {
      const request: PendingRequest = {
        id: this.nextId++,
        phase: "queue",
        trace,
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
      trace?.("read_file.worker.queue", "started");
      this.queue.push(request);
      this.dispatch();
    });
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.stopWorkers();
    }

    return this.closePromise;
  }

  private async stopWorkers() {
    const error = new Error("读取 Worker 池已关闭。");
    for (const request of this.queue.splice(0)) {
      this.complete(request, error);
    }

    const slots = [...this.slots];
    this.slots.clear();
    // 一个终止失败也必须等待其余线程退出，再向任务收尾报告不确定状态。
    const results = await Promise.allSettled([
      ...this.stopping,
      ...slots.map((slot) => this.stopSlot(slot, error)),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }

    if (this.stopFailure) {
      throw this.stopFailure;
    }
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
  }

  private startWorker() {
    const source = workerSource();
    const worker = new Worker(source, {
      execArgv: source.pathname.endsWith(".ts")
        ? ["--import", "tsx"]
        : undefined,
    });
    const slot: WorkerSlot = { worker, ready: false };

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
    request.trace?.("read_file.worker.queue", "ok");
    request.phase = slot.ready ? "response" : "startup";
    request.trace?.(`read_file.worker.${request.phase}`, "started");
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
    if (message.type === "ready") {
      slot.ready = true;
      const current = slot.current;
      if (current?.phase === "startup") {
        current.trace?.("read_file.worker.startup", "ok");
        current.phase = "response";
        current.trace?.("read_file.worker.response", "started");
      }

      return;
    }

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
      message.computeMs === undefined
        ? undefined
        : { computeMs: message.computeMs },
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
    const stopping = this.stopSlot(slot, error);
    this.stopping.add(stopping);
    void stopping.then(
      () => {
        this.stopping.delete(stopping);
        this.dispatch();
      },
      (cause: unknown) => {
        this.stopping.delete(stopping);
        this.stopFailure =
          cause instanceof Error ? cause : new Error("读取 Worker 退出失败。");
        this.dispatch();
      },
    );
  }

  private complete(
    request: PendingRequest,
    error?: Error,
    value?: ReadFileWorkerResult,
    details?: { computeMs: number },
  ) {
    request.trace?.(
      `read_file.worker.${request.phase}`,
      request.signal.aborted ? "cancelled" : error ? "error" : "ok",
      details,
    );
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
}
