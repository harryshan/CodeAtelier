/**
 * 把持久化的 tool_state 事件转换为时间线可显示的工具调度状态。
 * TimelineProjection 在连接更新时调用 ToolStatusIndex，渲染组件只读取已发布状态。
 * toolDisplayStatus 保留全量查询口径用于一次性计算与兼容性回归，不能在每张卡片渲染中重复调用。
 * 本模块不发起网络请求或修改持久会话；Engine 与 Agent Runtime 仍是状态的唯一生产者。
 *
 * 1. ToolDisplayStatus 给出稳定的标签和样式类别，区分等待依赖、参数检查或审批、等待可用 DAG slot、实际执行及失败后继阻断。
 * 2. toolDisplayStatus 按 taskId、callId 和可选 batchId 取该调用的最后一个 tool_state；没有状态的旧历史保守显示为“等待调度”。
 * 3. ToolStatusIndex 在连接层逐个索引状态，按调用和批次常数时间查询，保留无 batch 的兼容匹配。
 */

import type { Event } from "../shared/types.js";

export type ToolDisplayStatus = {
  label: string;
  tone: "waiting" | "running" | "blocked";
};

const states: Record<string, ToolDisplayStatus> = {
  waiting_dependencies: { label: "等待前置工具", tone: "waiting" },
  preparing: { label: "检查参数或等待审批", tone: "waiting" },
  queued: { label: "已显示，等待可用执行槽", tone: "waiting" },
  executing: { label: "正在执行", tone: "running" },
  succeeded: { label: "已完成", tone: "running" },
  blocked: { label: "因前置失败未执行", tone: "blocked" },
  failed: { label: "执行失败", tone: "blocked" },
};

const waiting: ToolDisplayStatus = { label: "等待调度", tone: "waiting" };

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

  return states[state ?? ""] ?? waiting;
}

/** 按调用和批次保存最后状态；无 batch 的旧事件同时适用于所有批次。 */
export class ToolStatusIndex {
  private calls = new Map<
    string,
    {
      latest: { id: number; state: string };
      wildcard?: { id: number; state: string };
      batches: Map<string, { id: number; state: string }>;
    }
  >();

  append(event: Event) {
    const key = JSON.stringify([event.taskId, event.data.callId]);
    const state = { id: event.id, state: event.data.state };
    let call = this.calls.get(key);
    if (!call) {
      call = { latest: state, batches: new Map() };
      this.calls.set(key, call);
    }

    call.latest = state;
    if (event.data.batchId) {
      call.batches.set(event.data.batchId, state);
    } else {
      call.wildcard = state;
    }
  }

  get(start: Event): ToolDisplayStatus {
    const call = this.calls.get(
      JSON.stringify([start.taskId, start.data.callId]),
    );
    let latest = call?.latest;
    if (start.data.batchId) {
      latest = call?.batches.get(start.data.batchId);
      if (call?.wildcard && (!latest || call.wildcard.id > latest.id)) {
        latest = call.wildcard;
      }
    }

    return states[latest?.state ?? ""] ?? waiting;
  }
}
