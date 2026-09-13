/**
 * 为压缩快照整理工具执行记录，供后续恢复时判断哪些结果已经保存、哪些仍然未知。
 * ContextManager 传入旧协议记录、数据库事件和可选的父快照，得到 ledger。
 *
 * 1. 继承父快照中的执行记录，再检查本次待压缩历史中的 function_call。
 * 2. 核对工具名、调用 ID、结果数量和正文，防止把别的任务中同名 ID 的结果配过来。
 * 3. 唯一匹配时保留错误、退出码和截断标记等信息，否则记为 unknown。
 *
 * recorded 只表示找到了匹配记录，不代表工具执行成功。这个判断必须来自保存的事件，不能靠摘要猜。
 */

import type { ContextSnapshot } from "./types.js";
import type { Event } from "../shared/types.js";

/** 根据已保存的工具事件判断状态；找不到记录就保留未知，不让摘要模型猜。 */
export function executionLedger(
  prefix: any[],
  events: Event[],
  previous?: ContextSnapshot,
): ContextSnapshot["ledger"] {
  const ledger = [...(previous?.ledger ?? [])];
  for (const item of prefix.filter(
    (record) => record.type === "function_call",
  )) {
    const outputs = prefix.filter(
      (record) =>
        record.type === "function_call_output" &&
        record.call_id === item.call_id,
    );
    // 服务可能在不同任务中重复使用 call_id，不能只取这个 ID 最后一次出现的结果。
    // 结果不一致或无法唯一匹配时记为未知，不能把旧任务的成功算到本次调用上。
    const matches = events.filter(
      (event) =>
        event.type === "tool_result" &&
        event.data.callId === item.call_id &&
        event.data.name === item.name &&
        outputs.length === 1 &&
        JSON.stringify(event.data.result) === outputs[0].output,
    );
    const saved = matches.length === 1 ? matches[0] : undefined;
    const result = saved?.data.result;
    ledger.push({
      callId: item.call_id,
      name: item.name,
      status: saved ? "recorded" : "unknown",
      result: saved
        ? JSON.stringify({
            error: result?.error,
            exitCode: result?.exitCode,
            truncated: result?.truncated,
          }).slice(0, 500)
        : "执行结果未知，必须先核实，不可盲目重放。",
    });
  }

  return ledger;
}
