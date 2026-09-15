/**
 * 为读取归档、工具结果归档和执行账本建立一次性的历史工具索引。
 * ContextManager 的压缩 Worker 先调用 createToolResultIndex，再把索引传给 read-projection、
 * tool-projection 和 snapshot；它们仍可在单元测试中省略索引并自行构建。
 *
 * 1. ToolResultIndex 按 call_id 保存调用、输出和持久化 tool_result 的唯一匹配结果。
 * 2. createToolResultIndex 只遍历 source 与 events 一次，并缓存事件结果的 JSON，避免每个投影阶段
 *    重复扫描完整历史和序列化大工具输出。
 * 3. savedToolResult 保留旧的按单项查询入口，供独立投影函数兼容使用。
 * 4. previewOutput 生成有明确省略标记的首尾/诊断摘录。
 *
 * 索引只确认已保存记录的精确对应关系；recorded 不表示成功，歧义调用、输出或事件必须保持未知。
 */

import type { Event } from "../shared/types.js";

export interface SavedToolResult {
  call: any;
  result: any;
}

export interface ToolResultIndex {
  savedOutput(index: number): SavedToolResult | undefined;
  savedCall(call: any): SavedToolResult | undefined;
}

/** 构建压缩阶段共享的唯一来源索引，避免 N 个输出各自扫描 N 条历史和 E 条事件。 */
export function createToolResultIndex(
  source: any[],
  events: Event[],
): ToolResultIndex {
  const calls = new Map<string, any[]>();
  const outputs = new Map<string, Array<{ index: number; output: string }>>();
  const eventResults = new Map<
    string,
    Array<{ result: any; serialized: string }>
  >();

  for (const item of source) {
    if (item.type === "function_call" && typeof item.call_id === "string") {
      const values = calls.get(item.call_id) ?? [];
      values.push(item);
      calls.set(item.call_id, values);
    }
  }

  for (const [index, item] of source.entries()) {
    if (
      item.type === "function_call_output" &&
      typeof item.call_id === "string" &&
      typeof item.output === "string"
    ) {
      const values = outputs.get(item.call_id) ?? [];
      values.push({ index, output: item.output });
      outputs.set(item.call_id, values);
    }
  }

  for (const event of events) {
    if (
      event.type !== "tool_result" ||
      typeof event.data?.callId !== "string" ||
      typeof event.data?.name !== "string"
    ) {
      continue;
    }

    const key = `${event.data.callId}\u0000${event.data.name}`;
    const values = eventResults.get(key) ?? [];
    values.push({
      result: event.data.result,
      serialized: JSON.stringify(event.data.result),
    });
    eventResults.set(key, values);
  }

  const savedByOutput = new Map<number, SavedToolResult>();
  const savedByCall = new Map<any, SavedToolResult>();
  for (const [callId, callValues] of calls) {
    const outputValues = outputs.get(callId) ?? [];
    // ID 重用使来源歧义；读取投影和账本都必须保持 unknown，不能把一次结果归给多次调用。
    if (callValues.length !== 1 || outputValues.length !== 1) {
      continue;
    }

    const call = callValues[0];
    const key = `${callId}\u0000${call.name}`;
    const matches = (eventResults.get(key) ?? []).filter(
      (event) => event.serialized === outputValues[0].output,
    );
    if (matches.length === 1) {
      const saved = { call, result: matches[0].result };
      savedByCall.set(call, saved);
      savedByOutput.set(outputValues[0].index, saved);
    }
  }

  return {
    savedOutput: (index) => savedByOutput.get(index),
    savedCall: (call) => savedByCall.get(call),
  };
}

/** 兼容独立调用方的单项查询；压缩主流程应传递共享索引。 */
export function savedToolResult(source: any[], item: any, events: Event[]) {
  const index = source.indexOf(item);
  if (index < 0) {
    return undefined;
  }

  return createToolResultIndex(source, events).savedOutput(index);
}

/** 摘录不能替代全文；完整已保存内容可通过快照回读。 */
export function previewOutput(text: string): string {
  const fragments = [text.slice(0, 400)];
  const diagnostic = /error|fail|exception|panic|todo|fixme|错误|失败|异常/i;
  let remaining = 1000;
  for (const line of text.split("\n")) {
    if (diagnostic.test(line) && remaining > 0) {
      const fragment = line.slice(0, Math.min(300, remaining));
      fragments.push(fragment);
      remaining -= fragment.length;
    }
  }

  fragments.push(text.slice(-400));

  return fragments.join("\n[摘录，非连续原文]\n");
}
