/**
 * 从当前会话 Snapshot 的持久化任务与事件计算可展示统计，供 SessionStatistics 组件和单元测试共用。
 * 本模块只读取共享类型，不请求 API、不修改 React 状态，也不把缺失的服务数据伪造成零值。
 *
 * 1. sessionStatistics 聚合 service 实报的 token、模型请求、工具结果和任务状态；旧历史没有 model_request 时，仅以已有 usage 作保守回退。
 * 2. 工具成功仅依据最终 tool_result 的错误和退出码判断；仍在审批或执行的调用不进入成功率分母。
 * 3. 运行时间使用 Task 的 finishedAt 或 task_end 事件；运行中任务以调用方传入的当前时间持续累加。
 * 4. formatTokenCount 与 formatDuration 为组件提供一致、紧凑且不依赖语言环境的显示文本。
 *
 * token 缓存明细是服务可选字段。任意一次实报缺失 cached_tokens 时，缓存和非缓存输入都标记为不完整，
 * 避免把未知缓存量错误显示为零。统计属于本地历史的展示投影，不能用于费用结算。
 */

import type { Event, Snapshot, Task, TaskStatus } from "../shared/types";

export type ModelPurpose = "task" | "compaction" | "title" | "approval";

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

const modelPurposes: ModelPurpose[] = [
  "task",
  "compaction",
  "title",
  "approval",
];

function isModelPurpose(value: unknown): value is ModelPurpose {
  return (
    typeof value === "string" && modelPurposes.includes(value as ModelPurpose)
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskEndTimes(events: Event[]) {
  const ends = new Map<string, number>();

  for (const event of events) {
    if (event.type !== "task_end") {
      continue;
    }

    const endedAt = timestamp(event.createdAt);
    if (endedAt !== undefined) {
      ends.set(event.taskId, endedAt);
    }
  }

  return ends;
}

function taskDuration(task: Task, endTimes: Map<string, number>, now: number) {
  const startedAt = timestamp(task.createdAt);
  if (startedAt === undefined) {
    return 0;
  }

  const finishedAt = timestamp(task.finishedAt) ?? endTimes.get(task.id);
  const stillRunning = task.status === "running" || task.status === "waiting";
  const endedAt = stillRunning ? now : finishedAt;

  return endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt);
}

/** 将当前会话完整历史投影为统计；now 由运行中的组件周期性更新，便于活跃时长连续显示。 */
export function sessionStatistics(
  snapshot: Snapshot,
  now = Date.now(),
): SessionStatistics {
  const usageEvents = snapshot.events.filter(
    (event) => event.type === "model_usage",
  );
  const modelRequestEvents = snapshot.events.filter(
    (event) => event.type === "model_request",
  );
  const requestsByTask = new Set(
    modelRequestEvents.map((event) => event.taskId),
  );
  const modelRequestsByPurpose: Record<ModelPurpose, number> = {
    task: 0,
    compaction: 0,
    title: 0,
    approval: 0,
  };
  const rounds = new Set<string>();

  for (const event of modelRequestEvents) {
    const purposeValue: unknown = event.data?.purpose;
    const purpose: ModelPurpose = isModelPurpose(purposeValue)
      ? purposeValue
      : "task";
    modelRequestsByPurpose[purpose]++;
    if (purpose === "task") {
      const step = numberValue(event.data?.step);
      rounds.add(event.taskId + ":" + (step ?? event.id));
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedInputTokens = 0;
  let cacheDetailsComplete = usageEvents.length > 0;

  for (const event of usageEvents) {
    const input = numberValue(event.data?.input_tokens);
    const output = numberValue(event.data?.output_tokens);
    const total = numberValue(event.data?.total_tokens);
    if (input === undefined || output === undefined || total === undefined) {
      continue;
    }

    inputTokens += input;
    outputTokens += output;
    totalTokens += total;
    const cached = numberValue(event.data?.input_tokens_details?.cached_tokens);
    if (cached === undefined) {
      cacheDetailsComplete = false;
    } else {
      cachedInputTokens += cached;
    }

    // 旧会话未记录请求开始，只有收到 usage 的已完成请求才可保守计为一次调用。
    if (!requestsByTask.has(event.taskId)) {
      const purposeValue: unknown = event.data?.purpose;
      const purpose: ModelPurpose = isModelPurpose(purposeValue)
        ? purposeValue
        : "task";
      modelRequestsByPurpose[purpose]++;
      if (purpose === "task") {
        const step = numberValue(event.data?.step);
        rounds.add(event.taskId + ":legacy:" + (step ?? event.id));
      }
    }
  }

  const toolStarts = snapshot.events.filter(
    (event) => event.type === "tool_start",
  );
  const toolResults = snapshot.events.filter(
    (event) => event.type === "tool_result",
  );
  const toolCallsByName: Record<string, number> = {};
  for (const event of toolStarts) {
    const name =
      typeof event.data?.name === "string" ? event.data.name : "未知工具";
    toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
  }

  const successfulToolCalls = toolResults.filter((event) => {
    const result = event.data?.result;

    return (
      !result?.error &&
      (result?.exitCode === undefined || result.exitCode === 0)
    );
  }).length;
  const taskCountsByStatus: Record<TaskStatus, number> = {
    running: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  const endTimes = taskEndTimes(snapshot.events);
  let totalRunMs = 0;

  for (const task of snapshot.tasks) {
    taskCountsByStatus[task.status]++;
    totalRunMs += taskDuration(task, endTimes, now);
  }

  const completedToolCalls = toolResults.length;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: cacheDetailsComplete ? cachedInputTokens : undefined,
    uncachedInputTokens: cacheDetailsComplete
      ? inputTokens - cachedInputTokens
      : undefined,
    cacheDetailsComplete,
    llmRequests:
      modelRequestsByPurpose.task +
      modelRequestsByPurpose.compaction +
      modelRequestsByPurpose.title +
      modelRequestsByPurpose.approval,
    llmRounds: rounds.size,
    modelRequestsByPurpose,
    toolCalls: toolStarts.length,
    completedToolCalls,
    successfulToolCalls,
    pendingToolCalls: Math.max(0, toolStarts.length - completedToolCalls),
    toolSuccessRate:
      completedToolCalls > 0
        ? successfulToolCalls / completedToolCalls
        : undefined,
    toolCallsByName,
    taskCount: snapshot.tasks.length,
    taskCountsByStatus,
    totalRunMs,
    activeTask:
      taskCountsByStatus.running > 0 || taskCountsByStatus.waiting > 0,
  };
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
