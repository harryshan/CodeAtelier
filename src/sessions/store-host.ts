/**
 * 固定业务 RPC 的 Worker 入口，由 AsyncStore 创建，禁止传入 SQL、数据库对象或事务函数。
 * 1. open 在本线程建立 Store，写线程负责启动恢复，只读线程没有 schema 或状态写入。
 * 2. 请求逐个 await 完成，内部大字段操作也在本线程执行，不再创建第二条写队列。
 * 3. 方法白名单分开读取和写入，关闭先释放 Store；返回受限错误和执行耗时，不记录正文。
 */
import { parentPort } from "node:worker_threads";
import { Store } from "./store.js";
import { READ_METHODS, WRITE_METHODS } from "./async-store.js";
import type { StoreWorkerRequest } from "./store-operations.js";
import { performance } from "node:perf_hooks";

let store: Store | undefined;
let readOnly = false;
let chain = Promise.resolve();

async function execute(request: StoreWorkerRequest) {
  if (request.operation === "close") {
    await store?.closeAsync();
    store = undefined;

    return;
  }

  if (request.operation !== "rpc") {
    throw new Error("非法存储协议。");
  }

  if (request.method === "open") {
    if (store) {
      throw new Error("存储已经打开。");
    }

    const options = request.args?.[0] as {
      readOnly?: boolean;
      interruptActive?: boolean;
      maxShardBytes?: number;
    };
    readOnly = Boolean(options.readOnly);
    store = new Store(request.file, { ...options, inline: true });

    return;
  }

  const allowed: readonly string[] = readOnly
    ? READ_METHODS
    : [...READ_METHODS, ...WRITE_METHODS];
  if (!store || !request.method || !allowed.includes(request.method)) {
    throw new Error("不允许的存储操作。");
  }

  if (readOnly) {
    store.refresh();
  }

  const method = store[request.method as (typeof READ_METHODS)[number]] as (
    ...args: unknown[]
  ) => unknown;

  return await method.apply(store, request.args ?? []);
}

parentPort?.on("message", (request: StoreWorkerRequest) => {
  chain = chain.then(async () => {
    const start = (performance.timeOrigin + performance.now()) * 1000;
    try {
      const value = await execute(request);
      parentPort?.postMessage({
        id: request.id,
        ok: true,
        value,
        timings: [
          {
            phase: "execute",
            start,
            end: (performance.timeOrigin + performance.now()) * 1000,
          },
        ],
      });
    } catch (error) {
      parentPort?.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "存储失败。",
      });
    }
  });
});
