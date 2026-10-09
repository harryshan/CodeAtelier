/**
 * 将 Snapshot 中的历史事件和待审批操作显示为对话时间线，并通过 api 提交审批决定。
 * 请求失败时交给传入的错误回调处理。
 *
 * 1. labels、textResult 和 toolDuration 处理工具名称、结果及耗时；旧记录缺少耗时时明确提示，不根据事件间隔猜测。
 * 2. 读取连接层 timeline-projection 的流式文本、输出和状态视图；渲染期间不聚合历史。MarkdownMessage 缓存相同正文的安全渲染。
 * 3. 显示编辑进度、工具输出及子任务记录；普通/Broker 宿主命令和 Git 共用输出卡片，未匹配的输出仍显示为文本。StreamingMessage 使用通知索引判断尝试是否仍在生成。
 * 4. 已完成任务默认仅保留用户输入和最后一条 agent 输出，将中间过程收纳为可展开区域；未完成、失败、取消和中断任务继续完整显示。
 * 5. useVirtualTimeline 缓存高度前缀和，滚动每帧合并并二分定位；ResizeObserver 批量更新高度，条目 ref 保持稳定。
 * 6. 显示仍在接收的文本和待审批按钮，把用户选择发给后端。
 *
 * 失败尝试的半截文本不能拼进重试后的回复。命令有输出不代表成功，退出码和错误信息要保留；
 * 视区外条目不创建 Markdown、工具卡片或审批控件，只有滚动尺寸占位，重新进入视区后才渲染。
 */

import {
  memo,
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
import type { ToolDisplayStatus } from "./tool-status";
import type { TimelineEntry, EditBatch } from "./timeline-entries";
import {
  outputTypeForTool,
  type OutputEvents,
  type ToolOutputCardState,
} from "./timeline-projection";
import type { SessionView } from "./session-view";
import { createTimelineLayout, timelineRange } from "./timeline-virtualization";

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
  run_with_permissions: "执行命令（宿主权限）",
  git: "Git 操作",
  subagent: "只读子代理协调",
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

function toolDuration(durationMs: unknown) {
  return typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs >= 0
    ? `${durationMs} ms`
    : "耗时未记录";
}

const modelUsagePurposeLabels: Record<string, string> = {
  task: "任务执行",
  compaction: "上下文摘要",
  title: "会话标题",
  approval: "工具审批",
  subagent: "只读子任务",
  tool_review: "长工具状态检查",
};

function ToolOutputCard({
  start,
  state,
  toolStatus,
}: {
  start: Event;
  state: ToolOutputCardState;
  toolStatus: ToolDisplayStatus;
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
      : toolStatus.label;
  const target =
    start.data.args?.command ||
    start.data.args?.action ||
    start.data.args?.path ||
    "";

  return (
    <details open className={s.outputCard}>
      <summary>
        <span className={`${s.toolDot} ${s[`toolDot${toolStatus.tone}`]}`} />
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
          <span>{toolDuration(state.result?.data.durationMs)}</span>
        </div>
      )}
    </details>
  );
}

const TIMELINE_ITEM_ESTIMATED_HEIGHT = 160;
const TIMELINE_OVERSCAN_HEIGHT = 480;

const TimelineEvent = memo(
  function TimelineEvent({
    event,
    outputEvents,
    editBatches,
    toolStatuses,
    subagentTaskIds,
  }: {
    event: Event;
    outputEvents: OutputEvents;
    editBatches: Map<string, EditBatch>;
    toolStatuses: Map<number, ToolDisplayStatus>;
    subagentTaskIds: Set<string>;
  }) {
    if (event.type === "user" || event.type === "assistant") {
      return (
        <article
          className={event.type === "user" ? s.userMessage : s.assistantMessage}
        >
          <div className={s.messageLabel}>
            {event.type === "user" ? "你" : "✳ CodeAtelier"}
            {event.type === "user" && subagentTaskIds.has(event.taskId) && (
              <small className={s.subagentBadge}>已启用只读子代理</small>
            )}
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

    if (event.type === "subagent_plan") {
      const subtasks = Array.isArray(event.data?.subtasks)
        ? event.data.subtasks
        : [];
      const ids = subtasks.map((plan: { id?: unknown }) =>
        typeof plan.id === "string" ? plan.id : "未命名",
      );

      return (
        <div className={s.notice} role="status">
          已规划只读子任务（{ids.length}）：{ids.join("、")}
        </div>
      );
    }

    if (event.type === "subagent_state") {
      const statuses: Record<string, string> = {
        planned: "已规划",
        queued: "排队中",
        running: "调查中",
        completed: "已完成",
        failed: "失败",
        cancelled: "已取消",
        interrupted: "已中断",
      };
      const id = typeof event.data?.id === "string" ? event.data.id : "未知";
      const status = statuses[String(event.data?.status)] ?? "未知状态";

      return (
        <div className={s.notice} role="status">
          只读子任务 {id}：{status}
        </div>
      );
    }

    if (event.type === "subagent_question") {
      const id =
        typeof event.data?.subagentId === "string"
          ? event.data.subagentId
          : "未知";
      const question =
        typeof event.data?.question === "string"
          ? event.data.question
          : "未记录问题";

      return (
        <div className={s.notice} role="status">
          只读子任务 {id} 提问：{question}
        </div>
      );
    }

    if (event.type === "subagent_collect") {
      const ids = Array.isArray(event.data?.ids)
        ? event.data.ids.filter(
            (id: unknown): id is string => typeof id === "string",
          )
        : [];

      return (
        <div className={s.notice} role="status">
          {ids.length
            ? `已收集子任务报告：${ids.join("、")}`
            : "本次没有新增子任务报告"}
        </div>
      );
    }

    if (event.type === "tool_start") {
      const toolStatus = toolStatuses.get(event.id) ?? {
        label: "等待调度",
        tone: "waiting" as const,
      };
      if (outputTypeForTool(event.data.name)) {
        const card = outputEvents.cards.get(event.id);

        return card ? (
          <ToolOutputCard start={event} state={card} toolStatus={toolStatus} />
        ) : null;
      }

      return (
        <details className={s.tool}>
          <summary>
            <span
              className={`${s.toolDot} ${s[`toolDot${toolStatus.tone}`]}`}
            />
            {labels[event.data.name] || event.data.name}
            <code>
              {event.data.args?.path ||
                event.data.args?.command ||
                event.data.args?.message ||
                ""}
            </code>
            <span className={s.outputStatus}>{toolStatus.label}</span>
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
            <span>{toolDuration(event.data.durationMs)}</span>
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

    if (
      event.type === "command_output" ||
      event.type === "capability_output" ||
      event.type === "git_output"
    ) {
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
          {event.data.effectiveWindowTokens && (
            <p>采用的窗口上限：{event.data.effectiveWindowTokens} token</p>
          )}
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
  },
  (previous, next) => {
    if (previous.event !== next.event) {
      return false;
    }

    const event = next.event;

    return (
      previous.outputEvents.cards.get(event.id) ===
        next.outputEvents.cards.get(event.id) &&
      previous.toolStatuses.get(event.id) === next.toolStatuses.get(event.id) &&
      (event.type !== "edit_progress" ||
        previous.editBatches.get(event.data.batchId) ===
          next.editBatches.get(event.data.batchId)) &&
      previous.subagentTaskIds.has(event.taskId) ===
        next.subagentTaskIds.has(event.taskId)
    );
  },
);

function StreamingMessage({
  active,
  data,
  entry,
}: {
  active?: Snapshot["tasks"][number];
  data: SessionView;
  entry: Extract<TimelineEntry, { kind: "streaming" }>;
}) {
  return (
    <article className={s.assistantMessage}>
      <div className={s.messageLabel}>
        ✳ CodeAtelier{" "}
        <span className={s.pulse}>
          {active &&
          entry.taskId === active.id &&
          !data.timeline.interruptedStreams.has(entry.key)
            ? "生成中"
            : "未完成的回复"}
        </span>
      </div>
      <MarkdownMessage text={entry.text} />
    </article>
  );
}

const TaskProcess = memo(function TaskProcess({
  data,
  entries,
  outputEvents,
  editBatches,
  toolStatuses,
  subagentTaskIds,
}: {
  data: SessionView;
  entries: TimelineEntry[];
  outputEvents: OutputEvents;
  editBatches: Map<string, EditBatch>;
  toolStatuses: Map<number, ToolDisplayStatus>;
  subagentTaskIds: Set<string>;
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
                toolStatuses={toolStatuses}
                subagentTaskIds={subagentTaskIds}
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
});

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

    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;
    setScrollMetrics((current) =>
      current.scrollTop === scrollTop &&
      current.viewportHeight === viewportHeight
        ? current
        : { scrollTop, viewportHeight },
    );
  }, [scrollContainerRef]);

  const recordHeights = useCallback((elements: HTMLDivElement[]) => {
    const updates = elements.map((element) => ({
      key: element.dataset.timelineKey,
      height: Math.ceil(element.getBoundingClientRect().height),
    }));
    setMeasuredHeights((current) => {
      let next = current;
      for (const { key, height } of updates) {
        if (key && height > 0 && current.get(key) !== height) {
          if (next === current) {
            next = new Map(current);
          }

          next.set(key, height);
        }
      }

      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    updateScrollMetrics();
    let frame: number | undefined;
    const scheduleMetrics = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        updateScrollMetrics();
      });
    };

    container.addEventListener("scroll", scheduleMetrics, { passive: true });
    const containerObserver = new ResizeObserver(scheduleMetrics);
    containerObserver.observe(container);
    const observer = new ResizeObserver((observedEntries) => {
      recordHeights(
        observedEntries.map((entry) => entry.target as HTMLDivElement),
      );
    });
    itemObserver.current = observer;

    for (const element of itemElements.current.values()) {
      observer.observe(element);
    }

    return () => {
      container.removeEventListener("scroll", scheduleMetrics);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }

      containerObserver.disconnect();
      observer.disconnect();
      itemObserver.current = undefined;
    };
  }, [recordHeights, scrollContainerRef, updateScrollMetrics]);

  useEffect(() => {
    const currentKeys = new Set(entryKeys);

    setMeasuredHeights((current) => {
      const next = new Map(
        Array.from(current).filter(([key]) => currentKeys.has(key)),
      );

      return next.size === current.size ? current : next;
    });
  }, [entryKeys]);

  const measureCallbacks = useMemo(
    () => new Map<string, (element: HTMLDivElement | null) => void>(),
    [],
  );
  useEffect(() => {
    const keys = new Set(entryKeys);
    for (const key of measureCallbacks.keys()) {
      if (!keys.has(key)) {
        measureCallbacks.delete(key);
      }
    }
  }, [entryKeys, measureCallbacks]);
  const measureItem = useCallback(
    (key: string) => {
      let callback = measureCallbacks.get(key);
      if (!callback) {
        callback = (element: HTMLDivElement | null) => {
          const previous = itemElements.current.get(key);
          if (previous === element) {
            return;
          }

          if (previous) {
            itemObserver.current?.unobserve(previous);
            itemElements.current.delete(key);
          }

          if (element) {
            itemElements.current.set(key, element);
            itemObserver.current?.observe(element);
          }
        };

        measureCallbacks.set(key, callback);
      }

      return callback;
    },
    [measureCallbacks],
  );

  const layout = useMemo(
    () =>
      createTimelineLayout(
        entries.map(
          (entry) =>
            measuredHeights.get(entry.key) ?? TIMELINE_ITEM_ESTIMATED_HEIGHT,
        ),
      ),
    [entries, measuredHeights],
  );
  const range = timelineRange(
    layout,
    scrollMetrics.scrollTop,
    scrollMetrics.viewportHeight,
    TIMELINE_OVERSCAN_HEIGHT,
  );

  return { measureItem, range };
}

export const Timeline = memo(function Timeline({
  data,
  onError,
  scrollContainerRef,
}: {
  data: SessionView;
  onError: (s: string) => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const {
    subagentTaskIds,
    active,
    outputEvents,
    toolStatuses,
    editBatches,
    entries,
  } = data.timeline;
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
              toolStatuses={toolStatuses}
              subagentTaskIds={subagentTaskIds}
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
              toolStatuses={toolStatuses}
              subagentTaskIds={subagentTaskIds}
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
});
