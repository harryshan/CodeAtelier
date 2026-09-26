/**
 * 从当前会话 Snapshot 的持久化任务与事件计算可展示统计，供 SessionStatistics 组件和单元测试共用。
 * 本模块只读取共享类型，不请求 API、不修改 React 状态，也不把缺失的服务数据伪造成零值。
 *
 * 1. sessionStatistics 通过 SessionEventStatistics 聚合 service 实报的 token、按主任务/子任务区分的模型请求、工具结果和任务状态；旧历史没有 model_request 时，仅以已有 usage 作保守回退。
 * 2. 工具成功仅依据最终 tool_result 的错误和退出码判断；仍在审批或执行的调用不进入成功率分母。
 * 3. prepareSessionStatistics 编译时长基线，时钟刷新只处理运行中的开始时间；运行时间使用 Task 的 startedAt、finishedAt 或 task_end 事件；排队等待不计入累计运行时间，运行中任务以调用方传入的当前时间持续累加。
 * 4. formatTokenCount 与 formatDuration 为组件提供一致、紧凑且不依赖语言环境的显示文本。
 *
 * token 缓存明细是服务可选字段。任意一次实报缺失 cached_tokens 时，缓存和非缓存输入都标记为不完整，
 * 避免把未知缓存量错误显示为零。统计属于本地历史的展示投影，不能用于费用结算。
 */

import type { Snapshot, Task, TaskStatus } from "../shared/types";
import {
  SessionEventStatistics,
  type EventStatisticsSnapshot,
} from "./session-event-statistics";

export type ModelPurpose =
  "task" | "compaction" | "title" | "approval" | "subagent";

export interface SessionStatistics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  cacheDetailsComplete: boolean;
  llmRequests: number;
  llmRounds: number;
  modelRequestsByPurpose: Record<ModelPurpose, number>;
  toolCalls: number;
  completedToolCalls: number;
  successfulToolCalls: number;
  pendingToolCalls: number;
  toolSuccessRate?: number;
  toolCallsByName: Record<string, number>;
  taskCount: number;
  taskCountsByStatus: Record<TaskStatus, number>;
  totalRunMs: number;
  activeTask: boolean;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskDuration(task: Task, endTimes: Map<string, number>, now: number) {
  // 新版排队任务尚未获得 startedAt；历史任务缺少该列时仍按 createdAt 兼容统计。
  if (task.startedAt === null) {
    return 0;
  }

  const startedAt = timestamp(task.startedAt) ?? timestamp(task.createdAt);
  if (startedAt === undefined) {
    return 0;
  }

  const finishedAt = timestamp(task.finishedAt) ?? endTimes.get(task.id);
  const stillRunning = task.status === "running" || task.status === "waiting";
  const endedAt = stillRunning ? now : finishedAt;

  return endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt);
}

/** 编译任务时长基线；时钟刷新只遍历正在运行的任务开始时间。 */
export function prepareSessionStatistics(
  events: EventStatisticsSnapshot,
  tasks: Task[],
) {
  const { endTimes, ...counts } = events;
  const taskCountsByStatus: Record<TaskStatus, number> = {
    queued: 0,
    running: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  const runningStarts: number[] = [];
  let finishedMs = 0;
  for (const task of tasks) {
    taskCountsByStatus[task.status]++;
    if (task.status === "running" || task.status === "waiting") {
      const start =
        task.startedAt === null
          ? undefined
          : (timestamp(task.startedAt) ?? timestamp(task.createdAt));
      if (start !== undefined) {
        runningStarts.push(start);
      }
    } else {
      finishedMs += taskDuration(task, endTimes, 0);
    }
  }

  const base = {
    ...counts,
    taskCount: tasks.length,
    taskCountsByStatus,
    activeTask:
      taskCountsByStatus.queued > 0 ||
      taskCountsByStatus.running > 0 ||
      taskCountsByStatus.waiting > 0,
  };

  return (now: number): SessionStatistics => ({
    ...base,
    totalRunMs:
      finishedMs +
      runningStarts.reduce((sum, start) => sum + Math.max(0, now - start), 0),
  });
}

/** 全量入口供非增量调用方与测试使用；UI 复用连接层编译后的统计。 */
export function sessionStatistics(
  snapshot: Snapshot,
  now = Date.now(),
): SessionStatistics {
  const events = new SessionEventStatistics();
  for (const event of snapshot.events) {
    events.append(event);
  }

  return prepareSessionStatistics(events.snapshot(), snapshot.tasks)(now);
}

/** token 数字在面板中使用分组分隔符，零和未知的区分由调用方决定。 */
export function formatTokenCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

/** 时长只显示到秒，避免运行中每次刷新都让面板布局抖动。 */
export function formatDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];

  if (hours) {
    parts.push(hours + " 小时");
  }

  if (minutes || hours) {
    parts.push(minutes + " 分");
  }

  parts.push(remainingSeconds + " 秒");

  return parts.join(" ");
}
