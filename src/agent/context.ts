/**
 * 为新任务或恢复的任务接上已有对话。Engine 传入 Store、会话 ID 和本轮用户消息，
 * 得到可以继续发给模型的历史记录。
 *
 * 1. 在线程外读取已保存的上下文和事件，找出缺少结果的 function_call，避免长历史阻塞 API 主线程。
 * 2. 从 tool_result 事件补回已知结果；结果缺失时按 toolCallId（兼容旧 callId）关联 Runner，或由 sandboxed_tool_process 关联其父 Agent Runtime。
 * 3. 恢复输出明确禁止自动重放，但不携带命令、路径、输出或日志原文。
 * 4. 追加本轮用户消息并保存，供当前任务和下次恢复使用。
 *
 * 这里只补齐协议要求的调用与结果，不会重跑工具。修改文件前仍须读取磁盘上的当前内容。
 */

import type { Event } from "../shared/types.js";

/** Runtime 可通过 IPC 实现此窄接口；Broker 内现有 Store 也结构兼容。 */
export interface TaskContextStore {
  contextAsync(sessionId: string): Promise<any[]>;
  eventsAsync(sessionId: string): Promise<Event[]>;
  appendContext(sessionId: string, items: any[]): void | Promise<void>;
}

function interruptedExecutionOutput(record: any) {
  if (!record || typeof record.executionInstanceId !== "string") {
    return "上次任务中断，执行结果未知（也可能尚未执行）。必须先检查当前文件状态，不可自动重放。";
  }

  return JSON.stringify({
    status: "execution_interrupted",
    message:
      record.state === "cancelled"
        ? "上次执行已取消；副作用可能已发生。必须先检查当前状态，不可自动重放。"
        : "上次执行的工具结果未完整持久化。必须先检查当前状态，不可自动重放。",
    replayAllowed: false,
    executionInstance: {
      executionInstanceId: record.executionInstanceId,
      kind: record.kind,
      mode: record.mode,
      state: record.state,
      pid: Number.isSafeInteger(record.pid) ? record.pid : undefined,
      pidKind: record.pidKind,
      processCreationTime100ns: record.processCreationTime100ns,
      sandboxRequested: record.sandboxRequested === true,
      sandboxApplied: record.sandboxApplied === true,
      failureCategory: record.failureCategory,
      sideEffectsPossible: record.sideEffectsPossible === true,
    },
  });
}

/** 补齐缺失的工具结果，再追加本轮用户消息。不会重新执行工具。 */
export async function prepareTaskContext(
  store: TaskContextStore,
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
  const executionByCallId = new Map<string, any>();
  const executionById = new Map<string, any>();
  for (const event of events) {
    if (event.type === "execution_instance") {
      if (typeof event.data?.executionInstanceId === "string") {
        executionById.set(event.data.executionInstanceId, event.data);
      }

      const callId = event.data?.toolCallId ?? event.data?.callId;
      if (typeof callId === "string") {
        executionByCallId.set(callId, event.data);
      }
    }
  }

  for (const event of events) {
    if (
      event.type === "sandboxed_tool_process" &&
      typeof event.data?.callId === "string" &&
      typeof event.data?.parentExecutionInstanceId === "string"
    ) {
      const parent = executionById.get(event.data.parentExecutionInstanceId);
      if (parent) {
        executionByCallId.set(event.data.callId, {
          ...parent,
          toolPid: event.data.pid,
        });
      }
    }
  }

  const appended: any[] = [];
  for (const item of [...input]) {
    if (item.type === "function_call" && !answeredCallIds.has(item.call_id)) {
      const feedback = {
        type: "function_call_output",
        call_id: item.call_id,
        output: savedResultsByCallId.has(item.call_id)
          ? JSON.stringify(savedResultsByCallId.get(item.call_id))
          : interruptedExecutionOutput(executionByCallId.get(item.call_id)),
      };
      input.push(feedback);
      appended.push(feedback);
    }
  }

  const user = { role: "user", content: prompt };
  input.push(user);
  appended.push(user);
  await store.appendContext(sessionId, appended);

  return input;
}
