/**
 * 由 useSessionConnection 独占的会话展示模型，在 React 渲染以外消费快照增量。
 * 1. SessionView 扩展服务 Snapshot，附带时间线、统计时钟函数和最近 Sandbox 状态。
 * 2. SessionViewModel.update 校验会话、按 ID 去重并排序新增事件，统一处理初始、增量及显式替换。
 * 3. 新事件只交给 TimelineProjection 和 SessionEventStatistics 一次；发布的数据不再原位修改。
 * 4. 无变化的任务、审批和事件保持引用；恢复复用同一连接刷新入口，切换会话新建模型。
 * 索引只活在当前连接生命周期，持有历史引用和聚合文本；不推导工具成功或重放任何任务。
 */

import type { Event, SandboxStatus, Snapshot } from "../shared/types";
import { TimelineProjection, type TimelineView } from "./timeline-projection";
import { SessionEventStatistics } from "./session-event-statistics";
import {
  prepareSessionStatistics,
  type SessionStatistics,
} from "./session-statistics";

export interface SessionView extends Snapshot {
  timeline: TimelineView;
  statistics: (now: number) => SessionStatistics;
  latestSandbox?: SandboxStatus;
}

/** 服务任务与审批是短元数据，不含历史正文；按值复用可避免空事件刷新触发重投影。 */
function reuse<T>(previous: T | undefined, next: T): T {
  return previous !== undefined &&
    JSON.stringify(previous) === JSON.stringify(next)
    ? previous
    : next;
}

export class SessionViewModel {
  private ids = new Set<number>();
  private timeline = new TimelineProjection();
  private counters = new SessionEventStatistics();
  private view?: SessionView;
  private lastId = 0;

  constructor(private sessionId: string) {}

  get cursor() {
    return this.lastId;
  }

  update(snapshot: Snapshot, replace = false): SessionView {
    if (
      snapshot.session.id !== this.sessionId ||
      snapshot.events.some((event) => event.sessionId !== this.sessionId)
    ) {
      throw new Error("会话快照不属于当前连接。");
    }

    if (replace) {
      this.ids.clear();
      this.timeline = new TimelineProjection();
      this.counters = new SessionEventStatistics();
      this.view = undefined;
      this.lastId = 0;
    }

    const added: Event[] = [];
    for (const event of snapshot.events) {
      if (!this.ids.has(event.id)) {
        this.ids.add(event.id);
        added.push(event);
      }
    }

    added.sort((left, right) => left.id - right.id);
    // 正常游标只追加。显式全量替换可重建；异常迟到的旧 ID 也保守重建，不能默默错排。
    if (added.length && added[0].id <= this.lastId) {
      const events = [...(this.view?.events ?? []), ...added].sort(
        (left, right) => left.id - right.id,
      );

      return this.update({ ...snapshot, events }, true);
    }

    let latestSandbox = this.view?.latestSandbox;
    for (const event of added) {
      this.timeline.append(event);
      this.counters.append(event);
      if (event.type === "sandbox_stage" && event.data?.mode) {
        latestSandbox = event.data as SandboxStatus;
      }

      this.lastId = event.id;
    }

    const tasks = reuse(this.view?.tasks, snapshot.tasks);
    const approvals = reuse(this.view?.approvals, snapshot.approvals);
    const events = added.length
      ? [...(this.view?.events ?? []), ...added]
      : (this.view?.events ?? []);
    const counts = this.counters.snapshot();
    const statistics =
      this.view &&
      tasks === this.view.tasks &&
      added.every(
        (event) =>
          ![
            "model_request",
            "model_usage",
            "tool_start",
            "tool_result",
            "task_end",
          ].includes(event.type),
      )
        ? this.view.statistics
        : prepareSessionStatistics(counts, tasks);
    this.view = {
      ...snapshot,
      session: reuse(this.view?.session, snapshot.session),
      events,
      tasks,
      approvals,
      timeline: this.timeline.publish(tasks, approvals),
      statistics,
      latestSandbox,
    };

    return this.view;
  }
}
