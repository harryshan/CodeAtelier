/**
 * 在连接收到新事件时聚合时间线，Timeline 只读取发布后的不可变视图。
 * 1. 输出卡片类型与 outputTypeForTool 保留普通命令/Git 及旧记录的显示约定。
 * 2. TimelineProjection.append 逐个消费新事件，索引流式尝试、工具输出/状态、编辑批次和最后回复。
 * 3. publish 复制展示索引并按任务状态收纳过程；仅复制引用，不重新读取历史正文。
 *    没有事件或任务/审批变化时直接复用上次视图。旧视图的 Map、Set 和记录不再修改。
 * 4. 流式条目移动到最后 delta 的位置；完整回复移除对应尝试，失败尝试仍可查看。
 * 本类仅有会话内存副作用，不发起工具、审批或网络请求。
 */

import type { Event, Snapshot } from "../shared/types";
import { ToolStatusIndex, type ToolDisplayStatus } from "./tool-status";
import {
  TaskProcessIndex,
  type EditBatch,
  type TimelineEntry,
} from "./timeline-entries";

export interface ToolOutputCardState {
  output: string;
  result?: Event;
}

export interface OutputEvents {
  cards: Map<number, ToolOutputCardState>;
}

export interface TimelineView {
  entries: TimelineEntry[];
  outputEvents: OutputEvents;
  editBatches: Map<string, EditBatch>;
  toolStatuses: Map<number, ToolDisplayStatus>;
  interruptedStreams: Set<string>;
  subagentTaskIds: Set<string>;
  active?: Snapshot["tasks"][number];
}

export function outputTypeForTool(name: string): string | undefined {
  return name === "run_command"
    ? "command_output"
    : name === "git"
      ? "git_output"
      : undefined;
}

const visibleTypes = new Set([
  "user",
  "assistant",
  "tool_start",
  "tool_result",
  "diff",
  "context_budget",
  "model_usage",
  "approval_assessed",
  "subagent_plan",
  "subagent_state",
  "subagent_question",
  "subagent_collect",
  "sandbox_fallback",
  "notice",
  "command_output",
  "git_output",
  "edit_progress",
]);

function streamKey(event: Event) {
  return `streaming:${event.taskId}:${event.data?.step}:${event.data?.attempt || 1}`;
}

export class TimelineProjection {
  private entries = new Map<number, TimelineEntry>();
  private streams = new Map<string, { id: number; text: string }>();
  private completedStreams = new Set<string>();
  private interruptedStreams = new Set<string>();
  private cards = new Map<number, ToolOutputCardState>();
  private calls = new Map<string, number>();
  private activeCards = new Map<string, number>();
  private editBatches = new Map<string, EditBatch>();
  private starts = new Map<number, Event>();
  private statuses = new ToolStatusIndex();
  private latestAssistant = new Map<string, number>();
  private processes = new TaskProcessIndex();
  private changed = true;
  private view?: TimelineView;
  private tasks?: Snapshot["tasks"];
  private approvals?: Snapshot["approvals"];

  append(event: Event) {
    const key = streamKey(event);
    if (event.type === "delta") {
      if (this.completedStreams.has(key)) {
        return;
      }

      const previous = this.streams.get(key);
      if (previous) {
        this.entries.delete(previous.id);
      }

      const text = (previous?.text ?? "") + event.data.text;
      this.streams.set(key, { id: event.id, text });
      this.entries.set(event.id, {
        key,
        kind: "streaming",
        taskId: event.taskId,
        text,
      });
      this.changed = true;

      return;
    }

    if (event.type === "tool_state") {
      this.statuses.append(event);
      this.changed = true;

      return;
    }

    if (!visibleTypes.has(event.type)) {
      return;
    }

    this.changed = true;
    if (event.type === "assistant") {
      const previous = this.streams.get(key);
      if (previous) {
        this.entries.delete(previous.id);
        this.streams.delete(key);
      }

      this.completedStreams.add(key);
      this.latestAssistant.set(event.taskId, event.id);
    }

    if (event.type === "notice") {
      this.interruptedStreams.add(key);
    }

    if (event.type === "tool_start") {
      // 状态查询只保留关联元数据；后续刷新不读取旧参数正文。
      this.starts.set(event.id, {
        ...event,
        data: { callId: event.data.callId, batchId: event.data.batchId },
      });
    }

    if (event.type === "edit_progress") {
      const previous = this.editBatches.get(event.data.batchId);
      if (previous) {
        this.entries.delete(previous.lastId);
      }

      const files = new Map(previous?.files);
      for (const file of event.data.files ?? [event.data]) {
        files.set(file.path, { status: file.status, error: file.error });
      }

      this.editBatches.set(event.data.batchId, { lastId: event.id, files });
    }

    if (this.appendOutput(event)) {
      return;
    }

    this.entries.set(event.id, {
      key: `event:${event.id}`,
      kind: "event",
      event,
    });
  }

  private appendOutput(event: Event): boolean {
    const callKey = event.taskId + ":" + event.data.callId;
    const outputType =
      event.type === "tool_start"
        ? outputTypeForTool(event.data.name)
        : undefined;
    if (outputType) {
      this.cards.set(event.id, { output: "" });
      this.calls.set(callKey, event.id);
      this.activeCards.set(outputType, event.id);
    }

    if (event.type === "command_output" || event.type === "git_output") {
      const id = event.data.callId
        ? this.calls.get(callKey)
        : this.activeCards.get(event.type);
      const card = id === undefined ? undefined : this.cards.get(id);
      if (card && id !== undefined) {
        this.cards.set(id, { ...card, output: card.output + event.data.text });

        return true;
      }
    }

    const resultType =
      event.type === "tool_result"
        ? outputTypeForTool(event.data.name)
        : undefined;
    if (resultType) {
      const id = this.calls.get(callKey);
      const card = id === undefined ? undefined : this.cards.get(id);
      if (card && id !== undefined) {
        this.cards.set(id, { ...card, result: event });
        this.activeCards.delete(resultType);

        return true;
      }
    }

    return false;
  }

  publish(
    tasks: Snapshot["tasks"],
    approvals: Snapshot["approvals"],
  ): TimelineView {
    if (
      !this.changed &&
      this.view &&
      this.tasks === tasks &&
      this.approvals === approvals
    ) {
      return this.view;
    }

    const entries = [...this.entries.values()];
    entries.push(
      ...approvals.map((approval): TimelineEntry => ({
        key: `approval:${approval.id}`,
        kind: "approval",
        approval,
      })),
    );
    for (const task of tasks) {
      if (task.status === "interrupted") {
        entries.push({
          key: `interrupted:${task.id}`,
          kind: "interrupted",
          taskId: task.id,
        });
      }
    }

    const toolStatuses = new Map<number, ToolDisplayStatus>();
    for (const [id, start] of this.starts) {
      toolStatuses.set(id, this.statuses.get(start));
    }

    this.view = {
      entries: this.processes.project(entries, this.latestAssistant, tasks),
      outputEvents: { cards: new Map(this.cards) },
      editBatches: new Map(this.editBatches),
      toolStatuses,
      interruptedStreams: new Set(this.interruptedStreams),
      subagentTaskIds: new Set(
        tasks.filter((task) => task.subagentsEnabled).map((task) => task.id),
      ),
      active: tasks.find(
        (task) =>
          task.status === "queued" ||
          task.status === "running" ||
          task.status === "waiting",
      ),
    };
    this.tasks = tasks;
    this.approvals = approvals;
    this.changed = false;

    return this.view;
  }
}
