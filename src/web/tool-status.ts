/**
 * 把持久化的 tool_state 事件转换为时间线可显示的工具调度状态。
 * Timeline 在渲染 tool_start 卡片时调用 toolDisplayStatus；该函数只读取历史事件，不发起网络请求、不修改会话，因而重连和刷新后
 * 会得到与实时 SSE 相同的状态。Engine 与 Agent Runtime 仍是状态的唯一生产者。
 *
 * 1. ToolDisplayStatus 给出稳定的标签和样式类别，区分等待依赖、已经显示但等待可用 DAG slot、实际执行及失败后继阻断。
 * 2. toolDisplayStatus 按 taskId、callId 和可选 batchId 取该调用的最后一个 tool_state；没有状态的旧历史保守显示为“等待调度”。
 */

import type { Event } from "../shared/types.js";

export type ToolDisplayStatus = {
  label: string;
  tone: "waiting" | "running" | "blocked";
};

const states: Record<string, ToolDisplayStatus> = {
  waiting_dependencies: { label: "等待前置工具", tone: "waiting" },
  queued: { label: "已显示，等待可用执行槽", tone: "waiting" },
  executing: { label: "正在执行", tone: "running" },
  succeeded: { label: "已完成", tone: "running" },
  blocked: { label: "因前置失败未执行", tone: "blocked" },
  failed: { label: "执行失败", tone: "blocked" },
};

export function toolDisplayStatus(
  events: Event[],
  start: Event,
): ToolDisplayStatus {
  let state: string | undefined;

  for (const event of events) {
    if (
      event.type === "tool_state" &&
      event.taskId === start.taskId &&
      event.data.callId === start.data.callId &&
      (!start.data.batchId ||
        !event.data.batchId ||
        event.data.batchId === start.data.batchId)
    ) {
      state = event.data.state;
    }
  }

  return states[state ?? ""] ?? { label: "等待调度", tone: "waiting" };
}
