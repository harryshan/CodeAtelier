/**
 * 为连接层与 Timeline 提供展示条目类型和已完成任务分组，不读取网络或历史正文。
 * 1. EditBatch、TimelineEntry 描述编辑聚合和可渲染条目，事件正文只保留引用。
 * 2. taskIdForEntry 统一关联任务；TaskProcessIndex 缓存连续任务段，只为改变的段重建折叠对象。
 * 3. collapseCompletedTaskProcesses 使用末次回复索引收纳过程。
 * 4. 分组保持原事件顺序和稳定 key，用户输入及最终回复始终留在外层。
 */

import type { Snapshot, Event } from "../shared/types";

export type EditBatch = {
  lastId: number;
  files: Map<string, { status: string; error?: string }>;
};

export type TimelineEntry =
  | { key: string; kind: "event"; event: Event }
  | { key: string; kind: "streaming"; taskId: string; text: string }
  | { key: string; kind: "approval"; approval: Snapshot["approvals"][number] }
  | { key: string; kind: "interrupted"; taskId: string }
  | { key: string; kind: "process"; taskId: string; entries: TimelineEntry[] };

export function taskIdForEntry(entry: TimelineEntry) {
  if (entry.kind === "event") {
    return entry.event.taskId;
  }

  if (entry.kind === "streaming" || entry.kind === "interrupted") {
    return entry.taskId;
  }

  if (entry.kind === "approval") {
    return entry.approval.taskId;
  }

  return entry.taskId;
}

/** 缓存连续任务段的折叠结果；只为条目或完成状态改变的段重新分组。 */
export class TaskProcessIndex {
  private segments = new Map<
    string,
    {
      entries: TimelineEntry[];
      completed: boolean;
      lastAssistant?: number;
      result: TimelineEntry[];
    }
  >();

  project(
    entries: TimelineEntry[],
    latest: Map<string, number>,
    tasks: Snapshot["tasks"],
  ) {
    const completed = new Set(
      tasks
        .filter((task) => task.status === "completed")
        .map((task) => task.id),
    );
    const next: typeof this.segments = new Map();
    const result: TimelineEntry[] = [];
    let start = 0;
    while (start < entries.length) {
      const taskId = taskIdForEntry(entries[start]);
      let end = start + 1;
      while (end < entries.length && taskIdForEntry(entries[end]) === taskId) {
        end++;
      }

      const key = entries[start].key;
      let segment = this.segments.get(key);
      if (
        !segment ||
        segment.completed !== completed.has(taskId) ||
        segment.lastAssistant !== latest.get(taskId) ||
        segment.entries.length !== end - start ||
        segment.entries.some((entry, index) => entry !== entries[start + index])
      ) {
        const group = entries.slice(start, end);
        segment = {
          entries: group,
          completed: completed.has(taskId),
          lastAssistant: latest.get(taskId),
          result: collapseCompletedTaskProcesses(group, latest, completed),
        };
      }

      next.set(key, segment);
      for (const entry of segment.result) {
        result.push(entry);
      }

      start = end;
    }

    this.segments = next;

    return result;
  }
}

export function collapseCompletedTaskProcesses(
  entries: TimelineEntry[],
  latestAssistantEventByTask: Map<string, number>,
  completedTaskIds: Set<string>,
) {
  const collapsed: TimelineEntry[] = [];
  let processEntries: TimelineEntry[] = [];
  let processTaskId: string | undefined;

  const flushProcess = () => {
    if (!processTaskId || !processEntries.length) {
      return;
    }

    collapsed.push({
      key: `process:${processTaskId}:${processEntries[0].key}`,
      kind: "process",
      taskId: processTaskId,
      entries: processEntries,
    });
    processEntries = [];
    processTaskId = undefined;
  };

  for (const entry of entries) {
    const taskId = taskIdForEntry(entry);
    const isCompletedTask = completedTaskIds.has(taskId);
    const isUserInput = entry.kind === "event" && entry.event.type === "user";
    const isFinalOutput =
      entry.kind === "event" &&
      entry.event.type === "assistant" &&
      latestAssistantEventByTask.get(taskId) === entry.event.id;

    if (!isCompletedTask || isUserInput || isFinalOutput) {
      flushProcess();
      collapsed.push(entry);
      continue;
    }

    if (processTaskId && processTaskId !== taskId) {
      flushProcess();
    }

    processTaskId = taskId;
    processEntries.push(entry);
  }

  flushProcess();

  return collapsed;
}
