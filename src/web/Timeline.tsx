/**
 * 将 Snapshot 中的历史事件和待审批操作显示为对话时间线，并通过 api 提交审批决定。
 * 请求失败时交给传入的错误回调处理。
 *
 * 1. labels 和 textResult 处理工具名称及结果的显示格式。
 * 2. 按任务、步骤和尝试次数合并流式文本；已有完整 assistant 事件时去掉对应的临时文本，未完成文本紧随其最后一个 delta，而非错误追加到时间线末尾。MarkdownMessage 负责安全渲染用户和 agent 文本。
 * 3. 合并同一编辑批次的逐文件最新状态；按调用 ID 聚合 run_command、git 的流式输出和最终结果，再显示其余工具、diff、预算和各类模型用量通知。
 * 4. 已完成任务默认仅保留用户输入和最后一条 agent 输出，将中间过程收纳为可展开区域；未完成、失败、取消和中断任务继续完整显示。
 * 5. 将可见条目及缓冲区交给虚拟列表；ResizeObserver 测得的高度用于在未渲染历史前后保留准确占位。
 * 6. 显示仍在接收的文本和待审批按钮，把用户选择发给后端。
 *
 * 失败尝试的半截文本不能拼进重试后的回复。命令有输出不代表成功，退出码和错误信息要保留；
 * 视区外条目不创建 Markdown、工具卡片或审批控件，只有滚动尺寸占位，重新进入视区后才渲染。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Snapshot, Event } from "../shared/types";
import { api } from "./api";
import s from "./app.module.css";
import { MarkdownMessage } from "./MarkdownMessage";
import { calculateVirtualTimelineRange } from "./timeline-virtualization";

const labels: Record<string, string> = {
  // 已移除的 list_files 工具仅用于展示旧会话记录。
  list_files: "浏览目录（旧记录）",
  read_file: "读取文件",
  // 已移除的 search 工具仅用于展示旧会话记录。
  search: "搜索代码（旧记录）",
  // 旧会话的 edit_file/write_file 仅用于历史展示；新版模型契约只公开 edit_files。
  edit_file: "精确修改（旧记录）",
  edit_files: "新建或精确修改文件",
  write_file: "写入文件（旧记录）",
  run_command: "执行命令",
  git: "Git 操作",
  // 保留旧会话事件的中文标签；旧调用只展示，不会被新版 ToolRunner 执行。
  git_status: "Git 状态（旧记录）",
  git_diff: "Git 差异（旧记录）",
  git_commit: "Git 提交（旧记录）",
  git_push: "Git 推送（旧记录）",
};

function textResult(event: Event) {
  return typeof event.data.result === "string"
    ? event.data.result
    : JSON.stringify(event.data.result, null, 2);
}

const modelUsagePurposeLabels: Record<string, string> = {
  task: "任务执行",
  compaction: "上下文摘要",
  title: "会话标题",
  approval: "工具审批",
};

const streamedToolOutputTypes: Record<string, string> = {
  run_command: "command_output",
  git: "git_output",
};

interface ToolOutputCardState {
  output: string;
  result?: Event;
}

function outputTypeForTool(name: string) {
  return streamedToolOutputTypes[name];
}

function toolForOutputType(type: string) {
  return Object.entries(streamedToolOutputTypes).find(
    ([, outputType]) => outputType === type,
  )?.[0];
}

/** 将有流式 stdout/stderr 的工具开始、输出和最终状态聚合；旧历史缺少 callId 时按工具顺序兼容。 */
function toolOutputCards(events: Event[]) {
  const cards = new Map<number, ToolOutputCardState>();
  const calls = new Map<string, number>();
  const outputEventIds = new Set<number>();
  const resultEventIds = new Set<number>();
  const activeCards = new Map<string, number>();

  for (const event of events) {
    const outputType =
      event.type === "tool_start"
        ? outputTypeForTool(event.data.name)
        : undefined;

    if (outputType) {
      cards.set(event.id, { output: "" });
      calls.set(event.taskId + ":" + event.data.callId, event.id);
      activeCards.set(outputType, event.id);
      continue;
    }

    const tool = toolForOutputType(event.type);
    if (tool) {
      const cardId = event.data.callId
        ? calls.get(event.taskId + ":" + event.data.callId)
        : activeCards.get(event.type);
      const card = cardId === undefined ? undefined : cards.get(cardId);

      if (card) {
        card.output += event.data.text;
        outputEventIds.add(event.id);
      }

      continue;
    }

    if (event.type === "tool_result" && outputTypeForTool(event.data.name)) {
      const cardId = calls.get(event.taskId + ":" + event.data.callId);
      const card = cardId === undefined ? undefined : cards.get(cardId);

      if (card) {
        card.result = event;
        resultEventIds.add(event.id);
        activeCards.delete(outputTypeForTool(event.data.name));
      }
    }
  }

  return { cards, outputEventIds, resultEventIds };
}

function ToolOutputCard({
  start,
  state,
}: {
  start: Event;
  state: ToolOutputCardState;
}) {
  const result = state.result?.data.result;
  const output =
    state.output || (typeof result?.output === "string" ? result.output : "");
  const status = result?.error
    ? "操作未完成"
    : result
      ? result.exitCode === 0
        ? "已完成"
        : "退出码：" + (result.exitCode ?? "未知")
      : "执行中";
  const target =
    start.data.args?.command ||
    start.data.args?.action ||
    start.data.args?.path ||
    "";

  return (
    <details open className={s.outputCard}>
      <summary>
        <span className={s.toolDot} />
        {labels[start.data.name] || start.data.name} <code>{target}</code>
        <span className={s.outputStatus}>{status}</span>
      </summary>
      {output && <pre className={s.outputText}>{output}</pre>}
      {result && (
        <div className={s.outputResult}>
          {result.error
            ? "错误：" + result.error
            : "退出码：" + (result.exitCode ?? "未知")}
          {result.truncated ? "；输出已截断" : ""}
          <span>{state.result?.data.durationMs} ms</span>
        </div>
      )}
    </details>
  );
}

const TIMELINE_ITEM_ESTIMATED_HEIGHT = 160;
const TIMELINE_OVERSCAN_HEIGHT = 480;

type EditBatch = {
  lastId: number;
  files: Map<string, { status: string; error?: string }>;
};

type TimelineEntry =
  | { key: string; kind: "event"; event: Event }
  | { key: string; kind: "streaming"; taskId: string; text: string }
  | { key: string; kind: "approval"; approval: Snapshot["approvals"][number] }
  | { key: string; kind: "interrupted"; taskId: string }
  | { key: string; kind: "process"; taskId: string; entries: TimelineEntry[] };

function taskIdForEntry(entry: TimelineEntry) {
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

function collapseCompletedTaskProcesses(
  entries: TimelineEntry[],
  events: Event[],
  tasks: Snapshot["tasks"],
) {
  const completedTaskIds = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  const latestAssistantEventByTask = new Map<string, number>();

  for (const event of events) {
    if (event.type === "assistant" && completedTaskIds.has(event.taskId)) {
      latestAssistantEventByTask.set(event.taskId, event.id);
    }
  }

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

function eventHasTimelineContent(
  event: Event,
  outputEvents: ReturnType<typeof toolOutputCards>,
  editBatches: Map<string, EditBatch>,
) {
  if (event.type === "tool_start" && outputTypeForTool(event.data.name)) {
    return outputEvents.cards.has(event.id);
  }

  if (event.type === "tool_result") {
    return !outputEvents.resultEventIds.has(event.id);
  }

  if (event.type === "edit_progress") {
    return editBatches.get(event.data.batchId)?.lastId === event.id;
  }

  if (event.type === "command_output" || event.type === "git_output") {
    return !outputEvents.outputEventIds.has(event.id);
  }

  return [
    "user",
    "assistant",
    "tool_start",
    "diff",
    "context_budget",
    "model_usage",
    "approval_assessed",
    "sandbox_fallback",
    "notice",
  ].includes(event.type);
}

function TimelineEvent({
  event,
  outputEvents,
  editBatches,
}: {
  event: Event;
  outputEvents: ReturnType<typeof toolOutputCards>;
  editBatches: Map<string, EditBatch>;
}) {
  if (event.type === "user" || event.type === "assistant") {
    return (
      <article
        className={event.type === "user" ? s.userMessage : s.assistantMessage}
      >
        <div className={s.messageLabel}>
          {event.type === "user" ? "你" : "✳ CodeAtelier"}
          <time>
            {new Date(event.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <MarkdownMessage text={event.data.text} />
      </article>
    );
  }

  if (event.type === "tool_start") {
    if (outputTypeForTool(event.data.name)) {
      const card = outputEvents.cards.get(event.id);

      return card ? <ToolOutputCard start={event} state={card} /> : null;
    }

    return (
      <details className={s.tool}>
        <summary>
          <span className={s.toolDot} />
          {labels[event.data.name] || event.data.name}
          <code>
            {event.data.args?.path ||
              event.data.args?.command ||
              event.data.args?.message ||
              ""}
          </code>
        </summary>
        <pre>{JSON.stringify(event.data.args, null, 2)}</pre>
      </details>
    );
  }

  if (event.type === "tool_result") {
    return (
      <details className={s.toolResult}>
        <summary>
          {event.data.result?.error ? "⚠ 操作未完成" : "✓ 工具结果"}
          <span>{event.data.durationMs} ms</span>
        </summary>
        <pre>{textResult(event)}</pre>
      </details>
    );
  }

  if (event.type === "edit_progress") {
    const batch = editBatches.get(event.data.batchId);
    const statuses: Record<string, string> = {
      not_attempted: "尚未执行",
      failed: "未写入",
      unknown: "写入中或结果未知，请核实文件",
      written: "已写入",
    };

    return (
      <details open className={s.toolResult}>
        <summary>文件编辑进度</summary>
        {Array.from(batch?.files ?? [], ([file, state]) => (
          <div key={file}>
            <code>{file}</code>：{statuses[state.status] || state.status}
            {state.error && `；错误：${state.error}`}
          </div>
        ))}
      </details>
    );
  }

  if (event.type === "diff") {
    return (
      <details open className={s.diff}>
        <summary>
          修改预览 <code>{event.data.path}</code>
        </summary>
        <pre>
          {event.data.diff.split("\n").map((line: string, index: number) => (
            <div
              key={index}
              className={
                line.startsWith("+")
                  ? s.added
                  : line.startsWith("-")
                    ? s.removed
                    : ""
              }
            >
              {line || " "}
            </div>
          ))}
        </pre>
      </details>
    );
  }

  if (event.type === "command_output" || event.type === "git_output") {
    return <pre className={s.toolResult}>{event.data.text}</pre>;
  }

  if (event.type === "context_budget") {
    return (
      <details className={s.toolResult}>
        <summary>
          上下文预算：
          {event.data.unit === "tokens" ? "token 模式" : "字符备用模式"}
        </summary>
        <p>
          {event.data.contextWindowTokens
            ? "服务公布窗口：" + event.data.contextWindowTokens + " token"
            : "服务未提供窗口容量"}
        </p>
        <p>输入预算：{event.data.inputLimit}</p>
        {event.data.outputTokens && (
          <p>
            输出预留：{event.data.outputTokens} token；安全余量：
            {event.data.safetyTokens} token
          </p>
        )}
      </details>
    );
  }

  if (event.type === "model_usage") {
    return (
      <details className={s.toolResult}>
        <summary>
          模型用量（服务实报）：输入 {event.data.input_tokens} / 输出{" "}
          {event.data.output_tokens} token
        </summary>
        <p>
          用途：
          {modelUsagePurposeLabels[event.data.purpose] || "任务执行"}
          ；本次合计：{event.data.total_tokens} token
        </p>
        <p>
          缓存输入：
          {event.data.input_tokens_details?.cached_tokens ?? "未提供"}
          ；推理输出：
          {event.data.output_tokens_details?.reasoning_tokens ?? "未提供"}
        </p>
      </details>
    );
  }

  if (event.type === "approval_assessed") {
    const decisionLabels: Record<string, string> = {
      approve: "低成本审批模型已自动通过",
      "human review": "低成本审批模型建议人工确认",
      reject: "低成本审批模型已拒绝",
    };

    return (
      <div role="status" className={s.notice}>
        {decisionLabels[event.data.decision] || "低成本审批模型已完成评估"}：
        {event.data.reason}
      </div>
    );
  }

  if (event.type === "sandbox_fallback") {
    return (
      <div role="alert" className={s.sandboxWarning}>
        <strong>Sandbox 未生效，已自动使用宿主权限继续。</strong>
        <span>{event.data.reason}</span>
      </div>
    );
  }

  if (event.type === "notice") {
    return (
      <div role="status" className={s.notice}>
        {event.data.text}
      </div>
    );
  }

  return null;
}

function StreamingMessage({
  active,
  data,
  entry,
}: {
  active?: Snapshot["tasks"][number];
  data: Snapshot;
  entry: Extract<TimelineEntry, { kind: "streaming" }>;
}) {
  return (
    <article className={s.assistantMessage}>
      <div className={s.messageLabel}>
        ✳ CodeAtelier{" "}
        <span className={s.pulse}>
          {active &&
          entry.taskId === active.id &&
          !data.events.some(
            (event) =>
              event.type === "notice" &&
              entry.key ===
                `streaming:${event.taskId}:${event.data.step}:${event.data.attempt || 1}`,
          )
            ? "生成中"
            : "未完成的回复"}
        </span>
      </div>
      <MarkdownMessage text={entry.text} />
    </article>
  );
}

function TaskProcess({
  data,
  entries,
  outputEvents,
  editBatches,
}: {
  data: Snapshot;
  entries: TimelineEntry[];
  outputEvents: ReturnType<typeof toolOutputCards>;
  editBatches: Map<string, EditBatch>;
}) {
  return (
    <details className={s.taskProcess} data-task-process>
      <summary>展开任务过程（{entries.length} 项）</summary>
      <div className={s.taskProcessContent}>
        {entries.map((entry) => {
          if (entry.kind === "event") {
            return (
              <TimelineEvent
                key={entry.key}
                event={entry.event}
                outputEvents={outputEvents}
                editBatches={editBatches}
              />
            );
          }

          if (entry.kind === "streaming") {
            return (
              <StreamingMessage key={entry.key} data={data} entry={entry} />
            );
          }

          return null;
        })}
      </div>
    </details>
  );
}

function useVirtualTimeline(
  entries: TimelineEntry[],
  scrollContainerRef: RefObject<HTMLDivElement | null>,
) {
  const [scrollMetrics, setScrollMetrics] = useState({
    scrollTop: 0,
    viewportHeight: 800,
  });
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number>>(
    () => new Map(),
  );
  const itemElements = useRef(new Map<string, HTMLDivElement>());
  const itemObserver = useRef<ResizeObserver | undefined>(undefined);
  const entryKeys = useMemo(() => entries.map((entry) => entry.key), [entries]);

  const updateScrollMetrics = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    setScrollMetrics({
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight,
    });
  }, [scrollContainerRef]);

  const recordHeight = useCallback((element: HTMLDivElement) => {
    const key = element.dataset.timelineKey;
    const height = Math.ceil(element.getBoundingClientRect().height);

    if (!key || height <= 0) {
      return;
    }

    setMeasuredHeights((current) => {
      if (current.get(key) === height) {
        return current;
      }

      const next = new Map(current);
      next.set(key, height);

      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    updateScrollMetrics();
    container.addEventListener("scroll", updateScrollMetrics, {
      passive: true,
    });
    const containerObserver = new ResizeObserver(updateScrollMetrics);
    containerObserver.observe(container);
    const observer = new ResizeObserver((observedEntries) => {
      for (const observedEntry of observedEntries) {
        recordHeight(observedEntry.target as HTMLDivElement);
      }
    });
    itemObserver.current = observer;

    for (const element of itemElements.current.values()) {
      observer.observe(element);
      recordHeight(element);
    }

    return () => {
      container.removeEventListener("scroll", updateScrollMetrics);
      containerObserver.disconnect();
      observer.disconnect();
      itemObserver.current = undefined;
    };
  }, [recordHeight, scrollContainerRef, updateScrollMetrics]);

  useEffect(() => {
    const currentKeys = new Set(entryKeys);

    setMeasuredHeights((current) => {
      const next = new Map(
        Array.from(current).filter(([key]) => currentKeys.has(key)),
      );

      return next.size === current.size ? current : next;
    });
  }, [entryKeys]);

  const measureItem = useCallback(
    (key: string) => (element: HTMLDivElement | null) => {
      const previous = itemElements.current.get(key);
      if (previous) {
        itemObserver.current?.unobserve(previous);
        itemElements.current.delete(key);
      }

      if (!element) {
        return;
      }

      itemElements.current.set(key, element);
      itemObserver.current?.observe(element);
      recordHeight(element);
    },
    [recordHeight],
  );

  const itemHeights = entries.map(
    (entry) => measuredHeights.get(entry.key) ?? TIMELINE_ITEM_ESTIMATED_HEIGHT,
  );
  const range = calculateVirtualTimelineRange(
    itemHeights,
    scrollMetrics.scrollTop,
    scrollMetrics.viewportHeight,
    TIMELINE_OVERSCAN_HEIGHT,
  );

  return { measureItem, range };
}

export function Timeline({
  data,
  onError,
  scrollContainerRef,
}: {
  data: Snapshot;
  onError: (s: string) => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const active = data.tasks.find(
    (task) =>
      task.status === "queued" ||
      task.status === "running" ||
      task.status === "waiting",
  );
  // 分别保留每次尝试的文本，避免将失败前的半截回复拼进成功结果；同时记住末尾 delta，保留历史顺序。
  const streaming = new Map<string, { text: string; lastEventId: number }>();

  for (const event of data.events) {
    if (event.type === "delta") {
      const key =
        event.taskId + ":" + event.data.step + ":" + (event.data.attempt || 1);
      const previous = streaming.get(key);

      streaming.set(key, {
        text: (previous?.text || "") + event.data.text,
        lastEventId: event.id,
      });
    }
  }

  for (const event of data.events) {
    if (event.type === "assistant") {
      streaming.delete(
        event.taskId + ":" + event.data.step + ":" + (event.data.attempt || 1),
      );
    }
  }

  const editBatches = new Map<string, EditBatch>();
  for (const event of data.events) {
    if (event.type !== "edit_progress") {
      continue;
    }

    const batch = editBatches.get(event.data.batchId) ?? {
      lastId: event.id,
      files: new Map<string, { status: string; error?: string }>(),
    };
    for (const file of event.data.files ?? [event.data]) {
      batch.files.set(file.path, { status: file.status, error: file.error });
    }

    batch.lastId = event.id;
    editBatches.set(event.data.batchId, batch);
  }

  const outputEvents = toolOutputCards(data.events);
  const streamingAfterEvent = new Map<number, TimelineEntry[]>();
  for (const [key, state] of streaming) {
    const entries = streamingAfterEvent.get(state.lastEventId) ?? [];

    entries.push({
      key: `streaming:${key}`,
      kind: "streaming",
      taskId: key.split(":", 1)[0],
      text: state.text,
    });
    streamingAfterEvent.set(state.lastEventId, entries);
  }

  const timelineEntries: TimelineEntry[] = [];
  for (const event of data.events) {
    if (eventHasTimelineContent(event, outputEvents, editBatches)) {
      timelineEntries.push({ key: `event:${event.id}`, kind: "event", event });
    }

    timelineEntries.push(...(streamingAfterEvent.get(event.id) ?? []));
  }

  timelineEntries.push(
    ...data.approvals.map((approval) => ({
      key: `approval:${approval.id}`,
      kind: "approval" as const,
      approval,
    })),
    ...data.tasks
      .filter((task) => task.status === "interrupted")
      .map((task) => ({
        key: `interrupted:${task.id}`,
        kind: "interrupted" as const,
        taskId: task.id,
      })),
  );
  const entries = collapseCompletedTaskProcesses(
    timelineEntries,
    data.events,
    data.tasks,
  );
  const { measureItem, range } = useVirtualTimeline(
    entries,
    scrollContainerRef,
  );
  const visibleEntries = entries.slice(range.startIndex, range.endIndex);

  return (
    <div className={s.timeline}>
      {range.beforeHeight > 0 && (
        <div
          aria-hidden="true"
          className={s.timelinePlaceholder}
          data-timeline-placeholder="before"
          style={{ height: range.beforeHeight }}
        />
      )}
      {visibleEntries.map((entry) => (
        <div
          key={entry.key}
          ref={measureItem(entry.key)}
          className={s.timelineItem}
          data-timeline-key={entry.key}
        >
          {entry.kind === "event" && (
            <TimelineEvent
              event={entry.event}
              outputEvents={outputEvents}
              editBatches={editBatches}
            />
          )}
          {entry.kind === "streaming" && (
            <StreamingMessage active={active} data={data} entry={entry} />
          )}
          {entry.kind === "process" && (
            <TaskProcess
              data={data}
              entries={entry.entries}
              outputEvents={outputEvents}
              editBatches={editBatches}
            />
          )}
          {entry.kind === "approval" && (
            <section className={s.approval}>
              <small>需要你的确认</small>
              <h3>允许这次操作？</h3>
              <pre>{entry.approval.description}</pre>
              <p>
                {entry.approval.reviewReason
                  ? "模型建议：" + entry.approval.reviewReason
                  : "请确认目标、参数及其可能影响。"}
              </p>
              <div className={s.actions}>
                {(
                  [
                    "once",
                    ...(entry.approval.repeatable ? ["session"] : []),
                    "deny",
                  ] as const
                ).map((decision) => (
                  <button
                    key={decision}
                    className={decision === "once" ? s.primary : ""}
                    onClick={() =>
                      api("/approvals/" + entry.approval.id, {
                        decision,
                      }).catch((error) => onError(error.message))
                    }
                  >
                    {decision === "once"
                      ? "允许一次"
                      : decision === "session"
                        ? "本次会话允许"
                        : "拒绝"}
                  </button>
                ))}
              </div>
            </section>
          )}
          {entry.kind === "interrupted" && (
            <div className={s.notice}>
              上次任务因服务重启而中断。可继续提问；不会自动重放命令。
            </div>
          )}
        </div>
      ))}
      {range.afterHeight > 0 && (
        <div
          aria-hidden="true"
          className={s.timelinePlaceholder}
          data-timeline-placeholder="after"
          style={{ height: range.afterHeight }}
        />
      )}
    </div>
  );
}
