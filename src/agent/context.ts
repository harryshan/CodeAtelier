/**
 * 为新任务或恢复的任务接上已有对话。Engine 传入 Store、会话 ID 和本轮用户消息，
 * 得到可以继续发给模型的历史记录。
 *
 * 1. 在线程外读取已保存的上下文和事件，找出缺少结果的 function_call，避免长历史阻塞 API 主线程。
 * 2. 从 tool_result 事件补回已知结果；找不到记录时，明确标为“执行结果未知”。
 * 3. 追加本轮用户消息并保存，供当前任务和下次恢复使用。
 *
 * 这里只补齐协议要求的调用与结果，不会重跑工具。修改文件前仍须读取磁盘上的当前内容。
 */

import type { Store } from "../sessions/store.js";

/** 补齐缺失的工具结果，再追加本轮用户消息。不会重新执行工具。 */
export async function prepareTaskContext(
  store: Store,
  sessionId: string,
  prompt: string,
): Promise<any[]> {
  const [input, events] = await Promise.all([
    store.contextAsync(sessionId),
    store.eventsAsync(sessionId),
  ]);

  // 崩溃前工具可能已经执行过，只是结果没写全；先找已有记录，不能直接重跑。
  const answeredCallIds = new Set(
    input
      .filter((i) => i.type === "function_call_output")
      .map((i) => i.call_id),
  );
  const savedResultsByCallId = new Map(
    events
      .filter((e) => e.type === "tool_result")
      .map((e) => [e.data.callId, e.data.result]),
  );

  for (const item of [...input]) {
    if (item.type === "function_call" && !answeredCallIds.has(item.call_id)) {
      input.push({
        type: "function_call_output",
        call_id: item.call_id,
        output: savedResultsByCallId.has(item.call_id)
          ? JSON.stringify(savedResultsByCallId.get(item.call_id))
          : "上次任务中断，执行结果未知（也可能尚未执行）。必须先检查当前文件状态，不可自动重放。",
      });
    }
  }

  input.push({ role: "user", content: prompt });
  store.saveContext(sessionId, input);

  return input;
}
