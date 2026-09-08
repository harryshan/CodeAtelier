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

  // 预留 JSON 转义及元数据空间，避免外层截断破坏分页游标。
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
