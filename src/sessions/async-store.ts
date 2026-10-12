/**
 * 生产服务的异步存储门面，主线程不打开 SQLite；同步 Store 仅作为 Worker 内部实现和夹具适配器。
 * 1. open 初始化唯一写 Worker，再启动两个只读 Worker；业务 RPC 仅允许下列固定方法。
 * 2. 写请求按提交顺序排队，读请求等待调用时的写回执后进入轮换读队列，保证因果可见性。
 * 3. 队列限制消息数和字节预算；只读执行期限 60 秒，未知写入不重试。空闲定时 checkpoint，关闭排空后先读后写释放连接。
 * 4. 方法类型从内部 Store 推导，排除数据库句柄、事务回调和生命周期，调用方必须 await。
 */
import type { Store } from "./store.js";
import { StoreWorkerQueue } from "./store-worker-queue.js";
import type { TraceRecorder } from "../tracing/recorder.js";
import { transferBytes } from "./transfer-budget.js";
import { resolveHistoryFile } from "./history-generation.js";
import type { Logger } from "pino";

export const READ_METHODS = [
  "taskPage",
  "replayDirectory",
  "replayEntry",
  "relatedEvents",
  "statistics",
  "historyPage",
  "snapshotPage",
  "eventBody",
  "relevantEventsAsync",
  "list",
  "get",
  "tasks",
  "hasEvent",
  "taskEvent",
  "task",
  "taskEvents",
  "replayCase",
  "hasUnfinishedTask",
  "queuedTasks",
  "subagents",
  "collectSubagents",
  "subagentRequest",
  "tokenAnchorAsync",
  "events",
  "eventsAsync",
  "context",
  "contextAsync",
  "latestContextSnapshot",
  "contextSnapshot",
  "latestContextSnapshotAsync",
  "contextSnapshotAsync",
] as const satisfies readonly (keyof Store)[];

export const WRITE_METHODS = [
  "checkpoint",
  "create",
  "createAsync",
  "startTaskAsync",
  "titleAsync",
  "startTitleGeneration",
  "completeTitleGeneration",
  "failTitleGeneration",
  "createTask",
  "status",
  "statusAsync",
  "event",
  "eventAsync",
  "persistToolResultAsync",
  "saveTokenAnchorAsync",
  "saveContext",
  "saveContextAsync",
  "appendContext",
  "appendContextAsync",
  "compactContextAsync",
  "startReplayCapture",
  "startReplayModelExchange",
  "finishReplayModelExchange",
  "startReplayTool",
  "finishReplayTool",
  "finishReplayCapture",
  "replayAsync",
  "planSubagents",
  "updateSubagent",
  "recordSubagentQuestion",
  "startSubagentRequest",
  "finishSubagentRequest",
  "commitCollectedToolResult",
] as const satisfies readonly (keyof Store)[];

type Method = (typeof READ_METHODS)[number] | (typeof WRITE_METHODS)[number];
type AsyncMethods = {
  [K in Method]: Store[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export class AsyncStore {
  declare checkpoint: AsyncMethods["checkpoint"];
  declare taskPage: AsyncMethods["taskPage"];
  declare replayDirectory: AsyncMethods["replayDirectory"];
  declare replayEntry: AsyncMethods["replayEntry"];
  declare relatedEvents: AsyncMethods["relatedEvents"];
  declare statistics: AsyncMethods["statistics"];
  declare historyPage: AsyncMethods["historyPage"];
  declare snapshotPage: AsyncMethods["snapshotPage"];
  declare eventBody: AsyncMethods["eventBody"];
  declare relevantEventsAsync: AsyncMethods["relevantEventsAsync"];
  declare list: AsyncMethods["list"];
  declare get: AsyncMethods["get"];
  declare tasks: AsyncMethods["tasks"];
  declare hasEvent: AsyncMethods["hasEvent"];
  declare taskEvent: AsyncMethods["taskEvent"];
  declare task: AsyncMethods["task"];
  declare taskEvents: AsyncMethods["taskEvents"];
  declare replayCase: AsyncMethods["replayCase"];
  declare hasUnfinishedTask: AsyncMethods["hasUnfinishedTask"];
  declare queuedTasks: AsyncMethods["queuedTasks"];
  declare subagents: AsyncMethods["subagents"];
  declare collectSubagents: AsyncMethods["collectSubagents"];
  declare subagentRequest: AsyncMethods["subagentRequest"];
  declare tokenAnchorAsync: AsyncMethods["tokenAnchorAsync"];
  declare events: AsyncMethods["events"];
  declare eventsAsync: AsyncMethods["eventsAsync"];
  declare context: AsyncMethods["context"];
  declare contextAsync: AsyncMethods["contextAsync"];
  declare latestContextSnapshot: AsyncMethods["latestContextSnapshot"];
  declare contextSnapshot: AsyncMethods["contextSnapshot"];
  declare latestContextSnapshotAsync: AsyncMethods["latestContextSnapshotAsync"];
  declare contextSnapshotAsync: AsyncMethods["contextSnapshotAsync"];
  declare create: AsyncMethods["create"];
  declare createAsync: AsyncMethods["createAsync"];
  declare startTaskAsync: AsyncMethods["startTaskAsync"];
  declare titleAsync: AsyncMethods["titleAsync"];
  declare startTitleGeneration: AsyncMethods["startTitleGeneration"];
  declare completeTitleGeneration: AsyncMethods["completeTitleGeneration"];
  declare failTitleGeneration: AsyncMethods["failTitleGeneration"];
  declare createTask: AsyncMethods["createTask"];
  declare status: AsyncMethods["status"];
  declare statusAsync: AsyncMethods["statusAsync"];
  declare event: AsyncMethods["event"];
  declare eventAsync: AsyncMethods["eventAsync"];
  declare persistToolResultAsync: AsyncMethods["persistToolResultAsync"];
  declare saveTokenAnchorAsync: AsyncMethods["saveTokenAnchorAsync"];
  declare saveContext: AsyncMethods["saveContext"];
  declare saveContextAsync: AsyncMethods["saveContextAsync"];
  declare appendContext: AsyncMethods["appendContext"];
  declare appendContextAsync: AsyncMethods["appendContextAsync"];
  declare compactContextAsync: AsyncMethods["compactContextAsync"];
  declare startReplayCapture: AsyncMethods["startReplayCapture"];
  declare startReplayModelExchange: AsyncMethods["startReplayModelExchange"];
  declare finishReplayModelExchange: AsyncMethods["finishReplayModelExchange"];
  declare startReplayTool: AsyncMethods["startReplayTool"];
  declare finishReplayTool: AsyncMethods["finishReplayTool"];
  declare finishReplayCapture: AsyncMethods["finishReplayCapture"];
  declare replayAsync: AsyncMethods["replayAsync"];
  declare planSubagents: AsyncMethods["planSubagents"];
  declare updateSubagent: AsyncMethods["updateSubagent"];
  declare recordSubagentQuestion: AsyncMethods["recordSubagentQuestion"];
  declare startSubagentRequest: AsyncMethods["startSubagentRequest"];
  declare finishSubagentRequest: AsyncMethods["finishSubagentRequest"];
  declare commitCollectedToolResult: AsyncMethods["commitCollectedToolResult"];

  private readonly writer: StoreWorkerQueue;
  private readonly readers: StoreWorkerQueue[];
  private fence: Promise<unknown> = Promise.resolve();
  private readonly accepted = new Set<Promise<unknown>>();
  private nextReader = 0;
  private acceptedBytes = 0;
  private closing?: Promise<void>;
  private maintenanceTimer?: NodeJS.Timeout;

  private constructor(private readonly file: string) {
    const entry = new URL(
      import.meta.url.endsWith(".ts") ? "./store-host.ts" : "./store-host.js",
      import.meta.url,
    );
    this.writer = new StoreWorkerQueue(undefined, undefined, entry);
    this.readers = Array.from(
      { length: 2 },
      () => new StoreWorkerQueue(undefined, undefined, entry, 60_000),
    );
    for (const method of [...READ_METHODS, ...WRITE_METHODS]) {
      Object.defineProperty(this, method, {
        configurable: true,
        value: (...args: unknown[]) => this.call(method, args),
      });
    }
  }

  static async open(
    file: string,
    options: { interruptActive?: boolean; maxShardBytes?: number } = {},
  ) {
    file = resolveHistoryFile(file, true);
    const store = new AsyncStore(file);
    try {
      await store.writer.request({
        operation: "rpc",
        file,
        sessionId: "",
        method: "open",
        args: [options],
      });
      await Promise.all(
        store.readers.map((reader) =>
          reader.request({
            operation: "rpc",
            file,
            sessionId: "",
            method: "open",
            args: [{ ...options, readOnly: true }],
          }),
        ),
      );

      return store;
    } catch (error) {
      await store.closeAsync();
      throw error;
    }
  }

  setTracer(traces: TraceRecorder) {
    for (const queue of [this.writer, ...this.readers]) {
      queue.setTracer(traces);
    }
  }

  startMaintenance(log: Logger) {
    if (this.maintenanceTimer) {
      return;
    }

    this.maintenanceTimer = setInterval(() => {
      if (!this.closing && this.accepted.size === 0) {
        void this.checkpoint().then(
          (shards) =>
            log.debug({
              module: "storage",
              event: "storage.checkpoint",
              shards,
            }),
          (error: Error) =>
            log.warn({
              module: "storage",
              event: "storage.checkpoint_failed",
              err: error,
            }),
        );
      }
    }, 30_000);
    this.maintenanceTimer.unref();
  }

  private call(method: Method, args: unknown[]): Promise<unknown> {
    if (this.closing) {
      return Promise.reject(new Error("Store 已关闭。"));
    }

    if (this.accepted.size >= 1024) {
      return Promise.reject(new Error("Store 请求队列已满。"));
    }

    let bytes: number;
    try {
      bytes = transferBytes(args, 128 * 1024 * 1024 - this.acceptedBytes);
    } catch (error) {
      return Promise.reject(error);
    }

    this.acceptedBytes += bytes;
    const request = {
      operation: "rpc" as const,
      file: this.file,
      sessionId: "",
      method,
      args,
    };
    let result: Promise<unknown>;
    if ((READ_METHODS as readonly string[]).includes(method)) {
      const reader = this.readers[this.nextReader++ % this.readers.length]!;
      result = this.fence.then(() => reader.request(request));
    } else {
      result = this.writer.request(request);
      this.fence = result.then(
        () => undefined,
        () => undefined,
      );
    }

    this.accepted.add(result);
    const finished = () => {
      this.accepted.delete(result);
      this.acceptedBytes -= bytes;
    };

    void result.then(finished, finished);

    return result;
  }

  async drain() {
    await Promise.allSettled([...this.accepted]);
  }

  closeAsync(): Promise<void> {
    clearInterval(this.maintenanceTimer);
    this.closing ??= (async () => {
      await this.drain();
      const results = await Promise.allSettled(
        this.readers.map((queue) => queue.close()),
      );
      // Read-only last-close cannot checkpoint. Release readers before the writer's final SQLite close.
      results.push(...(await Promise.allSettled([this.writer.close()])));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
    })();

    return this.closing;
  }

  close() {
    return this.closeAsync();
  }
}

/** 测试可使用同步适配器；生产 createApp 只创建 AsyncStore。 */
export type SessionStore =
  Pick<Store, Method | "setTracer" | "drain" | "closeAsync"> | AsyncStore;
