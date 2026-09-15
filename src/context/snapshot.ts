/**
 * 为压缩快照整理工具执行记录，供后续恢复时判断哪些结果已经保存、哪些仍然未知。
 * ContextManager 传入旧协议记录、数据库事件和可选的父快照，得到 ledger。
 *
 * 1. 继承父快照中的执行记录，再检查本次待压缩历史中的 function_call。
 * 2. 核对工具名、调用 ID、结果数量和正文，防止把别的任务中同名 ID 的结果配过来。
 * 3. 唯一匹配时保留错误、退出码和截断标记；批次逐文件状态及 Git 嵌套阶段也保留，否则记为 unknown。
 * 4. resultFacts 剥离正文但不截断状态 JSON，防止后续摘要丢失部分成功、未知文件或 Git 失败阶段。
 *
 * recorded 只表示找到了匹配记录，不代表工具执行成功。这个判断必须来自保存的事件，不能靠摘要猜。
 */

import type { ContextSnapshot } from "./types.js";
import type { Event } from "../shared/types.js";
import { createToolResultIndex, type ToolResultIndex } from "./tool-result.js";

/** 根据已保存的工具事件判断状态；找不到记录就保留未知，不让摘要模型猜。 */
export function executionLedger(
  prefix: any[],
  events: Event[],
  previous?: ContextSnapshot,
  index: ToolResultIndex = createToolResultIndex(prefix, events),
): ContextSnapshot["ledger"] {
  const ledger = [...(previous?.ledger ?? [])];
  for (const item of prefix.filter(
    (record) => record.type === "function_call",
  )) {
    // 服务可能在不同任务中重复使用 call_id。共享索引仍要求唯一输出和精确持久化结果，
    // 但不会为每个调用重新扫描历史或序列化大输出。
    const saved = index.savedCall(item);
    const result = saved?.result;
    ledger.push({
      callId: item.call_id,
      name: item.name,
      status: saved ? "recorded" : "unknown",
      result: saved
        ? JSON.stringify(resultFacts(item.name, result))
        : "执行结果未知，必须先核实，不可盲目重放。",
    });
  }

  return ledger;
}

/** 只提取明确的执行事实；正文已在快照中，状态不能由摘要模型补猜。 */
function resultFacts(name: string, result: any): Record<string, any> {
  const facts: Record<string, any> = {
    error: result?.error,
    exitCode: result?.exitCode,
    truncated: result?.truncated,
  };
  for (const key of ["status", "cancelled", "timedOut", "signal"]) {
    if (result?.[key] !== undefined) {
      facts[key] = result[key];
    }
  }

  if (name === "edit_files" && Array.isArray(result?.files)) {
    facts.batchId = result.batchId;
    facts.files = result.files.map((file: any) => ({
      path: file?.path,
      status: file?.status,
      changed: file?.changed,
      error: file?.error,
    }));
  }

  if (name === "git" && result && typeof result === "object") {
    facts.paths = result.paths;
    for (const key of ["add", "stage", "commit"]) {
      if (result[key] !== undefined) {
        // commit 输出含提交标识，保留该阶段完整结果；不解析自然语言输出猜测提交。
        facts[key] =
          key === "commit" || result[key] === null
            ? result[key]
            : resultFacts("process", result[key]);
      }
    }
  }

  return facts;
}
