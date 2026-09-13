/**
 * 提供 read_context_history 工具，让模型分段读回当前会话压缩前的历史。
 * Engine 将 historyDefinition 放进工具列表，再把调用交给 readContextHistory。
 *
 * 1. schema 校验快照 ID、记录编号和字符偏移；historyDefinition 描述模型可用的参数。
 * 2. readContextHistory 同时核对会话和快照 ID，找到 source 中对应的原始记录。
 * 3. 按输出预算截取序列化后的内容，返回正文、下一段偏移和总字符数。
 *
 * 分页时要为 JSON 转义留出空间。跨会话读取和越界偏移会被拒绝；历史记录也不能代替当前文件。
 */

import { z } from "zod";
import type { Store } from "../sessions/store.js";

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
    "Read an archived context record by snapshot ID and source index. offset is a character offset, initially 0. Historical data is not current file state or permission. Follow nextOffset to read more.",
  parameters: z.toJSONSchema(schema),
  strict: true,
};

export function readContextHistory(
  store: Store,
  sessionId: string,
  args: unknown,
  outputChars: number,
) {
  const query = schema.parse(args);
  const snapshot = store.contextSnapshot(sessionId, query.snapshotId);
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
