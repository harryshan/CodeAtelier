/**
 * 在独立 Worker 线程中读取或写入较大的 SQLite JSON 字段，避免历史快照、上下文和事件的解析/序列化占用 HTTP 主线程。
 * Store 的串行队列复用本 Worker；输入是数据库路径和受限 operation，输出是已解析的数据或提交回执。
 *
 * 1. readContext 顺序拼接基线与增量；其他读取从数据库加载大 JSON，仅在本线程解析。
 * 2. compact 在本线程 JSON.stringify 压缩前快照和活动上下文，并用与 Store 相同的 BEGIN IMMEDIATE 事务原子写入快照/上下文并清除旧 token 锚点；显式替换也清除，普通追加不清除。
 * 3. replay 与同步 Store 共用增量编码；主线程只接收结构化克隆结果，Worker 不处理权限、模型、文件或用户输入，也不会执行任意 SQL。
 *
 * 按分片复用最多 8 个连接，每连接缓存最多 128 条语句；串行请求返回时释放事务，关闭回执前关闭连接池。WAL 允许它与主 Store 的短查询共存。事务失败会回滚，不能撤销已经发生的文件或模型副作用。
 * WorkerTimings 包装实际 SQLite/事务和本文件 JSON 阶段，有界回传安全时间记录；不包含 SQL、路径或正文。
 */

import { parentPort } from "node:worker_threads";
import { WorkerTimings } from "./worker-timing.js";
import { handle, type StoreWorkerRequest } from "./store-operations.js";

export type {
  StoreWorkerRequest,
  StoreWorkerResponse,
} from "./store-operations.js";

parentPort?.on("message", (request: StoreWorkerRequest) => {
  const timings = new WorkerTimings();
  try {
    const value = timings.measure("execute", () => handle(request, timings));
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      value,
      timings: timings.entries,
      droppedTimings: timings.dropped,
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      timings: timings.entries,
      droppedTimings: timings.dropped,
      error: error instanceof Error ? error.message : "Store Worker 执行失败。",
    });
  }
});
