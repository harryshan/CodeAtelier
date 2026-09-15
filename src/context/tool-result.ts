/**
 * 为读取归档和其他工具归档提供共同的来源核对与文本摘录。
 * read-projection、tool-projection 使用这些纯函数，不访问文件、不修改历史或推断执行成功。
 *
 * 1. savedToolResult 要求调用、结果和同名持久化事件唯一且完整匹配，返回原调用和结果。
 * 2. previewOutput 保留首尾及限额内诊断行，明确说明摘录不连续；关键词不用于判断成败。
 *
 * 找不到可信来源时返回 undefined；输出中已有的失败/未知状态由各工具投影保留。
 */

import type { Event } from "../shared/types.js";

export function savedToolResult(source: any[], item: any, events: Event[]) {
  if (item.type !== "function_call_output" || typeof item.output !== "string") {
    return undefined;
  }

  const calls = source.filter(
    (record) =>
      record.type === "function_call" && record.call_id === item.call_id,
  );
  const outputs = source.filter(
    (record) =>
      record.type === "function_call_output" && record.call_id === item.call_id,
  );
  if (calls.length !== 1 || outputs.length !== 1) {
    return undefined;
  }

  const matches = events.filter(
    (event) =>
      event.type === "tool_result" &&
      event.data.callId === item.call_id &&
      event.data.name === calls[0].name &&
      JSON.stringify(event.data.result) === item.output,
  );
  if (matches.length !== 1) {
    return undefined;
  }

  return { call: calls[0], result: matches[0].data.result };
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
