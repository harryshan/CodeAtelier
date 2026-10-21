/**
 * 在连接收到新事件时聚合时间线，Timeline 只读取发布后的不可变视图。
 * 1. 输出卡片类型与 outputTypeForTool 关联普通命令、Broker 宿主命令和已退役 Git 工具的历史输出，保留旧无调用 ID 记录的显示约定。
 * 2. TimelineProjection.append 逐个消费新事件，索引流式尝试、工具输出/状态、编辑批次和最后回复。
 * 3. publish 复制展示索引并按任务状态收纳过程；仅复制引用，不重新读取历史正文。
 *    没有事件或任务/审批变化时直接复用上次视图。旧视图的 Map、Set 和记录不再修改。
 * 4. 流式条目移动到最后 delta 的位置；完整回复移除对应尝试，失败尝试仍可查看。
 * 5. 子任务状态按主任务/子 ID 原位更新，重复检查点不追加提示；审批用量保留在原始事件和统计，不单独展示卡片。
 * 6. 审批和中断提示锚定所属任务末尾；未加载旧任务不产生孤立提示，最新无事件任务仍保留中断说明。
 * 本类仅有会话内存副作用，不发起工具、审批或网络请求。
 */

import type { Event, Snapshot } from "../shared/types";
import { ToolStatusIndex, type ToolDisplayStatus } from "./tool-status";
import {
  TaskProcessIndex,
  anchorTaskControls,
  taskIdForEntry,
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
    : name === "run_with_permissions"
      ? "capability_output"
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
  "capability_output",
  "git_output",
  "edit_progress",
]);

function streamKey(event: Event) {
  return `streaming:${event.taskId}:${event.data?.step}:${event.data?.attempt || 1}`;
}

export class TimelineProjection {
  private entries = new Map<number, TimelineEntry>();
  private streams = new Map<string, { id: number; text: string }>();
  private subagentStates = new Map<string, { id: number; status: string }>();
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
    if (event.bodyDeferred && event.type === "delta") {
      this.entries.set(event.id, {
        key: `event:${event.id}`,
        kind: "event",
        event,
      });
      this.changed = true;

      return;
    }

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

    // 只调整展示；SessionViewModel 仍保存完整事件并独立累计所有用途的用量。
    if (event.type === "model_usage" && event.data?.purpose === "approval") {
      return;
    }

    if (this.appendSubagentState(event)) {
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

  private appendSubagentState(event: Event): boolean {
    if (
      event.type !== "subagent_state" ||
      event.bodyDeferred ||
      typeof event.data?.id !== "string" ||
      typeof event.data?.status !== "string"
    ) {
      return false;
    }

    const key = JSON.stringify([event.taskId, event.data.id]);
    const previous = this.subagentStates.get(key);
    if (previous?.status === event.data.status) {
      return true;
    }

    // 保留首次出现的位置与 React key，避免每次检查点落盘都新增行或重新播报。
    // 用新条目替换，不修改已经发布给 React 的历史视图。
    const id = previous?.id ?? event.id;
    this.subagentStates.set(key, { id, status: event.data.status });
    this.entries.set(id, { key: `event:${id}`, kind: "event", event });
    this.changed = true;

    return true;
  }

  private appendOutput(event: Event): boolean {
    if (event.bodyDeferred && event.type !== "tool_result") {
      return false;
    }

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

    if (
      event.type === "command_output" ||
      event.type === "capability_output" ||
      event.type === "git_output"
    ) {
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
    const loadedTasks = new Set(entries.map(taskIdForEntry));
    const controls: TimelineEntry[] = approvals.map((approval) => ({
      key: `approval:${approval.id}`,
      kind: "approval",
      approval,
    }));
    for (const task of tasks) {
      // 快照包含未加载旧页的任务元数据；不能把这些历史提示提前放到当前页底部。
      // 最新任务可能尚无可见事件，仍须说明中断；待审批操作也不得因缺少锚点丢失。
      if (
        task.status === "interrupted" &&
        (loadedTasks.has(task.id) || task.id === tasks.at(-1)?.id)
      ) {
        controls.push({
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
      entries: this.processes.project(
        anchorTaskControls(entries, controls),
        this.latestAssistant,
        tasks,
      ),
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
