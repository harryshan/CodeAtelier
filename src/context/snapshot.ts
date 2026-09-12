/**
 * 文件作用：根据持久化工具事件生成压缩快照的执行状态清单。
 *
 * 模块协作与输入输出：
 * 由 ContextManager 在压缩时生成 ledger，输入待处理协议项、持久化事件和可选父快照。
 *
 * 代码结构与执行顺序：
 * 1. 先继承上一快照的执行清单，再扫描前缀中的 function_call。
 * 2. 同时核对工具名、调用 ID、唯一输出及输出内容，避免把其他任务复用 ID 的结果算到当前调用。
 * 3. 有唯一记录时保留 error、exitCode 和 truncated 等有限诊断，否则标为 unknown。
 *
 * 关键约束：
 * recorded 仅表示存在匹配记录，不表示执行成功；状态由事件证据确定，不能由摘要推断。
 */

import type { ContextSnapshot } from "./types.js";
import type { Event } from "../shared/types.js";

/** 执行状态来自工具事件，不由摘要模型判断；丢失记录一律按未知处理。 */
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
    // 不能只按 call_id 查最后一个事件：自建服务可能跨任务复用 ID。
    // 输出不一致或存在歧义时保守标为未知，绝不借旧任务的成功记录推断本次成功。
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
