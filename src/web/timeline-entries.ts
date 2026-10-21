/**
 * 为连接层与 Timeline 提供展示条目类型和已结束任务分组，不读取网络或历史正文。
 * 1. EditBatch、TimelineEntry 描述编辑聚合和可渲染条目，事件正文只保留引用。
 * 2. taskIdForEntry 统一关联任务；TaskProcessIndex 缓存连续任务段，只为改变的段重建折叠对象。
 * 3. collapseEndedTaskProcesses 使用末次回复索引收纳所有终态任务的过程。
 * 4. 分组保持原事件顺序和稳定 key，用户输入及末次完整回复始终留在外层，审批和中断提示不被过程隐藏。
 * 5. anchorTaskControls 将合成控件插入所属任务最后一项之后；无锚点的必要控件保留在末尾，不重排原事件。
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

/** 先按任务定位最后条目，再线性合并控件，避免历史提示随续聊漂移到会话末尾。 */
export function anchorTaskControls(
  entries: TimelineEntry[],
  controls: TimelineEntry[],
): TimelineEntry[] {
  const lastKeys = new Map<string, string>();
  for (const entry of entries) {
    lastKeys.set(taskIdForEntry(entry), entry.key);
  }

  const anchored = new Map<string, TimelineEntry[]>();
  const unanchored: TimelineEntry[] = [];
  for (const control of controls) {
    const key = lastKeys.get(taskIdForEntry(control));
    if (key === undefined) {
      unanchored.push(control);
      continue;
    }

    const group = anchored.get(key) ?? [];
    group.push(control);
    anchored.set(key, group);
  }

  const result: TimelineEntry[] = [];
  for (const entry of entries) {
    result.push(entry);
    for (const control of anchored.get(entry.key) ?? []) {
      result.push(control);
    }
  }

  return result.concat(unanchored);
}

/** 缓存连续任务段的折叠结果；只为条目或终态标记改变的段重新分组。 */
export class TaskProcessIndex {
  private segments = new Map<
    string,
    {
      entries: TimelineEntry[];
      ended: boolean;
      lastAssistant?: number;
      result: TimelineEntry[];
    }
  >();

  project(
    entries: TimelineEntry[],
    latest: Map<string, number>,
    tasks: Snapshot["tasks"],
  ) {
    const ended = new Set(
      tasks
        .filter((task) =>
          ["completed", "failed", "cancelled", "interrupted"].includes(
            task.status,
          ),
        )
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
        segment.ended !== ended.has(taskId) ||
        segment.lastAssistant !== latest.get(taskId) ||
        segment.entries.length !== end - start ||
        segment.entries.some((entry, index) => entry !== entries[start + index])
      ) {
        const group = entries.slice(start, end);
        segment = {
          entries: group,
          ended: ended.has(taskId),
          lastAssistant: latest.get(taskId),
          result: collapseEndedTaskProcesses(group, latest, ended),
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

export function collapseEndedTaskProcesses(
  entries: TimelineEntry[],
  latestAssistantEventByTask: Map<string, number>,
  endedTaskIds: Set<string>,
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
    const isEndedTask = endedTaskIds.has(taskId);
    const isUserInput = entry.kind === "event" && entry.event.type === "user";
    const isFinalOutput =
      entry.kind === "event" &&
      entry.event.type === "assistant" &&
      latestAssistantEventByTask.get(taskId) === entry.event.id;

    // 中断提示与审批控件不是执行过程；折叠不能使其消失或不可操作。
    const isStandaloneControl =
      entry.kind === "interrupted" || entry.kind === "approval";
    if (!isEndedTask || isUserInput || isFinalOutput || isStandaloneControl) {
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
