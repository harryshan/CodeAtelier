/**
 * 文件作用：为新任务恢复已保存的模型协议上下文。
 * 代码结构：读取历史与工具结果，补齐未配对调用的已知或未知状态，再追加用户消息并保存。
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
