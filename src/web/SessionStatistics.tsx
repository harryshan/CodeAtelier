/**
 * 在当前对话右上角显示可折叠的本地会话统计，供 App 在已加载 Snapshot 后渲染。
 * 它依赖 session-statistics 的纯投影和 App 的 CSS Module，不访问后端或保存任何用户偏好。
 *
 * 1. useEffect 在切换会话时恢复折叠状态；仅在任务运行或等待审批时每秒刷新一次时钟。
 * 2. 折叠按钮只显示累计运行时间，避免干扰对话；展开后分组展示 token、LLM、工具和任务统计。
 * 3. Token 区域明确区分服务实报总量与可选缓存明细；缺少明细时显示未知，而非假定没有缓存。
 * 4. 工具成功率的分母是已完成结果，待审批或仍执行的调用单独显示，避免将进行中操作当作失败。
 *
 * 组件只展示当前 session 已持久化或正在接收的 Snapshot；刷新和重启后会从同一历史事件重新计算。
 */

import { useEffect, useState } from "react";
import type { Snapshot } from "../shared/types";
import {
  formatDuration,
  formatTokenCount,
  sessionStatistics,
} from "./session-statistics";
import s from "./app.module.css";

const purposeLabels = {
  task: "任务",
  compaction: "摘要",
  title: "标题",
  approval: "审批",
};

function toolSummary(calls: Record<string, number>) {
  return Object.entries(calls)
    .map(([name, count]) => name + " " + count)
    .join(" · ");
}

/** 当前会话的轻量统计面板；运行中的会话每秒更新时长，其他数值跟随 Snapshot 的 SSE 刷新。 */
export function SessionStatistics({ data }: { data: Snapshot }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const statistics = sessionStatistics(data, now);
  const purposeSummary = Object.entries(statistics.modelRequestsByPurpose)
    .filter(([, count]) => count > 0)
    .map(
      ([purpose, count]) =>
        purposeLabels[purpose as keyof typeof purposeLabels] + " " + count,
    )
    .join(" · ");

  useEffect(() => {
    setExpanded(false);
    setNow(Date.now());
  }, [data.session.id]);

  useEffect(() => {
    if (!statistics.activeTask) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, [statistics.activeTask]);

  return (
    <aside className={s.sessionStatistics} aria-label="会话统计">
      <button
        className={s.statisticsToggle}
        aria-expanded={expanded}
        aria-label={expanded ? "收起会话统计" : "展开会话统计"}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>统计</span>
        <strong>{formatDuration(statistics.totalRunMs)}</strong>
        <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && (
        <section className={s.statisticsPanel} aria-live="polite">
          <div className={s.statisticsHeading}>
            <div>
              <small>当前对话</small>
              <h2>会话统计</h2>
            </div>
            <span className={statistics.activeTask ? s.statisticsLive : ""}>
              {statistics.activeTask ? "进行中" : "已同步"}
            </span>
          </div>
          <dl className={s.statisticsGrid}>
            <div>
              <dt>累计运行</dt>
              <dd>{formatDuration(statistics.totalRunMs)}</dd>
            </div>
            <div>
              <dt>任务</dt>
              <dd>
                {statistics.taskCount} 次 · 完成{" "}
                {statistics.taskCountsByStatus.completed}
              </dd>
            </div>
            <div>
              <dt>LLM 请求</dt>
              <dd>{statistics.llmRequests} 次</dd>
              <small>
                {statistics.llmRounds} 轮
                {purposeSummary ? " · " + purposeSummary : ""}
              </small>
            </div>
            <div>
              <dt>工具调用</dt>
              <dd>{statistics.toolCalls} 次</dd>
              <small>
                {statistics.completedToolCalls
                  ? `成功 ${statistics.successfulToolCalls}/${statistics.completedToolCalls}（${Math.round((statistics.toolSuccessRate ?? 0) * 100)}%）`
                  : "尚无已完成调用"}
                {statistics.pendingToolCalls
                  ? ` · 进行中 ${statistics.pendingToolCalls}`
                  : ""}
              </small>
            </div>
          </dl>
          <div className={s.statisticsTokens}>
            <h3>Token（服务实报）</h3>
            <dl>
              <div>
                <dt>合计</dt>
                <dd>{formatTokenCount(statistics.totalTokens)}</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>{formatTokenCount(statistics.outputTokens)}</dd>
              </div>
              <div>
                <dt>输入（缓存 / 非缓存）</dt>
                <dd>
                  {statistics.cacheDetailsComplete
                    ? `${formatTokenCount(statistics.cachedInputTokens ?? 0)} / ${formatTokenCount(statistics.uncachedInputTokens ?? 0)}`
                    : `明细未完整提供（输入合计 ${formatTokenCount(statistics.inputTokens)}）`}
                </dd>
              </div>
            </dl>
          </div>
          {statistics.toolCalls > 0 && (
            <p
              className={s.statisticsTools}
              title={toolSummary(statistics.toolCallsByName)}
            >
              工具分布：{toolSummary(statistics.toolCallsByName)}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
