/**
 * 文件作用：为新任务恢复已保存的模型协议上下文。
 *
 * 模块协作与输入输出：
 * 由 Engine 在启动或恢复任务时调用，输入 Store、会话 ID 和当前用户消息，返回可继续发送给模型的协议项数组。
 *
 * 代码结构与执行顺序：
 * 1. 从保存的上下文建立已回答调用集合，并从 tool_result 事件索引已保存结果。
 * 2. 逐个补齐尚无输出的 function_call：有记录则引用结果，无记录则写明执行结果未知。
 * 3. 追加当前用户消息并保存上下文，让本轮任务和后续恢复共享同一历史。
 *
 * 关键约束：
 * 这里只修复协议配对，不重新执行工具；历史读取不能替代修改前读取当前文件。
 */

import type { Store } from "../sessions/store.js";

/** 为新任务恢复协议上下文；保存的历史不代表磁盘上的最新代码。 */
export function prepareTaskContext(
  store: Store,
  sessionId: string,
  prompt: string,
): any[] {
  const input = store.context(sessionId);

  // 崩溃可能留下尚未写入结果的调用。优先补齐已知结果，不重新执行副作用。
  const answeredCallIds = new Set(
    input
      .filter((i) => i.type === "function_call_output")
      .map((i) => i.call_id),
  );
  const savedResultsByCallId = new Map(
    store
      .events(sessionId)
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
