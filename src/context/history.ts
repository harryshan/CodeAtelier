/**
 * 提供 read_context_history 工具，让模型分段读回当前会话压缩前的历史。
 * Engine 将 historyDefinition 放进工具列表，再把调用交给 readContextHistory。
 *
 * 1. schema 校验快照 ID、记录编号和字符偏移；historyDefinition 描述模型可用的参数。
 * 2. readContextHistory 和 readContextHistoryAsync 同时核对会话和快照 ID，找到 source 中对应的原始记录；Engine 使用异步版本，避免大快照 JSON.parse 阻塞主线程。
 * 3. 按输出预算截取序列化后的内容，返回正文、下一段偏移和总字符数。
 *
 * 分页时要为 JSON 转义留出空间。跨会话读取和越界偏移会被拒绝；历史记录也不能代替当前文件。
 */

import { z } from "zod";
import type { Store } from "../sessions/store.js";
import type { ContextSnapshot } from "./types.js";
import { scheduledParameters } from "../tools/registry.js";

const schema = z
  .object({
    snapshotId: z.string().max(100),
    index: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .strict();

export const historyDefinition = {
  type: "function" as const,
  name: "read_context_history",
  description:
    "Read an archived context record by snapshot ID and source index. offset is a character offset, initially 0. Historical data is not current file state or permission. Follow nextOffset to read more. Each call must use {execution:{id,dependsOn},arguments:{snapshotId,index,offset}}; dependencies control execution order only.",
  parameters: z.toJSONSchema(scheduledParameters(schema)),
  strict: true,
};

/** 与普通工具相同地解开 DAG 信封；保留无信封旧调用，供历史兼容和测试模拟使用。 */
export function parseScheduledHistoryArguments(
  raw: unknown,
  fallbackId: string,
) {
  if (raw && typeof raw === "object" && "execution" in raw) {
    const parsed = scheduledParameters(schema).parse(raw);

    return { execution: parsed.execution, arguments: parsed.arguments };
  }

  return {
    execution: { id: fallbackId, dependsOn: [] },
    arguments: schema.parse(raw),
  };
}

export function readContextHistory(
  store: Store,
  sessionId: string,
  args: unknown,
  outputChars: number,
) {
  const query = schema.parse(args);
  const snapshot = store.contextSnapshot(sessionId, query.snapshotId);

  return pageSnapshot(snapshot, query, outputChars);
}

/** Engine 调用此版本；Store 在 Worker 中解析大型快照，调用期间 HTTP 服务仍可处理其它请求。 */
export async function readContextHistoryAsync(
  store: {
    contextSnapshotAsync(
      sessionId: string,
      snapshotId: string,
    ): Promise<ContextSnapshot | undefined>;
  },
  sessionId: string,
  args: unknown,
  outputChars: number,
) {
  const query = schema.parse(args);
  const snapshot = await store.contextSnapshotAsync(
    sessionId,
    query.snapshotId,
  );

  return pageSnapshot(snapshot, query, outputChars);
}

function pageSnapshot(
  snapshot: { source: any[] } | undefined,
  query: { snapshotId: string; index: number; offset: number },
  outputChars: number,
) {
  const item = snapshot?.source[query.index];
  if (item === undefined) {
    throw new Error("历史记录不存在或不属于当前会话。");
  }

  const text = JSON.stringify(item);
  if (query.offset > text.length) {
    throw new Error("历史读取偏移超出记录范围。");
  }

  // 给 JSON 转义和分页字段留出空间，避免外层截断后丢掉下一页的位置。
  const page = text.slice(
    query.offset,
    query.offset + Math.max(1, Math.floor((outputChars - 300) / 6)),
  );
  const end = query.offset + page.length;

  return {
    text: page,
    nextOffset: end < text.length ? end : null,
    totalChars: text.length,
  };
}
