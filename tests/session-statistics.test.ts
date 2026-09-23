/**
 * 验证当前会话统计如何从持久化 Snapshot 投影 token、模型、工具和运行时间。
 * 测试只调用 web/session-statistics 的纯函数，不依赖浏览器、SQLite 或真实模型。
 *
 * 1. 首组使用新版 model_request、完整缓存明细、成功/失败/进行中工具和结束任务，验证聚合口径。
 * 2. 次组模拟升级前只有 model_usage 的历史及缺失缓存明细，验证保守回退而不把未知缓存写成零。
 * 3. 末组验证运行中任务按传入时钟累加、排队任务不计运行时间，并检查紧凑格式化结果。
 *
 * 事件内容是最小可观察历史，不断言 React 组件的内部状态；真实 UI 的默认折叠和展开由 Playwright 覆盖。
 */

import { expect, it } from "vitest";
import type { Event, Snapshot, Task } from "../src/shared/types.js";
import {
  formatDuration,
  formatTokenCount,
  sessionStatistics,
} from "../src/web/session-statistics.js";

const startedAt = "2026-09-16T10:00:00.000Z";
const finishedAt = "2026-09-16T10:02:00.000Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    sessionId: "session-1",
    status: "completed",
    subagentsEnabled: false,
    createdAt: startedAt,
    finishedAt,
    ...overrides,
  };
}

function event(
  id: number,
  type: string,
  data: unknown,
  taskId = "task-1",
): Event {
  return {
    id,
    sessionId: "session-1",
    taskId,
    type,
    data,
    createdAt: finishedAt,
  };
}

function snapshot(events: Event[], tasks: Task[]): Snapshot {
  return {
    session: {
      id: "session-1",
      title: "统计测试",
      workspace: "C:/workspace",
      createdAt: startedAt,
      updatedAt: finishedAt,
      titleState: "completed",
    },
    events,
    tasks,
    approvals: [],
  };
}

it("aggregates recorded model requests, cache details, tool outcomes and completed task duration", () => {
  const statistics = sessionStatistics(
    snapshot(
      [
        event(1, "model_request", { purpose: "task", step: 1, attempt: 1 }),
        event(2, "model_request", { purpose: "task", step: 1, attempt: 2 }),
        event(3, "model_request", { purpose: "compaction", step: 1 }),
        event(4, "model_usage", {
          purpose: "task",
          step: 1,
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 40 },
        }),
        event(5, "model_usage", {
          purpose: "compaction",
          input_tokens: 30,
          output_tokens: 10,
          total_tokens: 40,
          input_tokens_details: { cached_tokens: 5 },
        }),
        event(6, "tool_start", { name: "read_file", callId: "read" }),
        event(7, "tool_result", { callId: "read", result: { content: "ok" } }),
        event(8, "tool_start", { name: "run_command", callId: "command" }),
        event(9, "tool_result", {
          callId: "command",
          result: { exitCode: 1, output: "failed" },
        }),
        event(10, "tool_start", { name: "write_file", callId: "write" }),
        event(11, "task_end", { status: "completed" }),
      ],
      [task()],
    ),
    Date.parse("2026-09-16T10:05:00.000Z"),
  );

  expect(statistics).toMatchObject({
    inputTokens: 130,
    outputTokens: 30,
    totalTokens: 160,
    cachedInputTokens: 45,
    uncachedInputTokens: 85,
    cacheDetailsComplete: true,
    llmRequests: 3,
    llmRounds: 1,
    modelRequestsByPurpose: { task: 2, compaction: 1 },
    toolCalls: 3,
    completedToolCalls: 2,
    successfulToolCalls: 1,
    pendingToolCalls: 1,
    toolCallsByName: { read_file: 1, run_command: 1, write_file: 1 },
    taskCount: 1,
    totalRunMs: 120000,
    activeTask: false,
  });
  expect(statistics.toolSuccessRate).toBe(0.5);
});

it("uses usage as a conservative legacy request fallback and leaves incomplete cache details unknown", () => {
  const statistics = sessionStatistics(
    snapshot(
      [
        event(1, "model_usage", {
          purpose: "task",
          step: 1,
          input_tokens: 50,
          output_tokens: 10,
          total_tokens: 60,
        }),
      ],
      [task()],
    ),
  );

  expect(statistics.llmRequests).toBe(1);
  expect(statistics.llmRounds).toBe(1);
  expect(statistics.cacheDetailsComplete).toBe(false);
  expect(statistics.cachedInputTokens).toBeUndefined();
  expect(statistics.uncachedInputTokens).toBeUndefined();
});

it("continues counting an active task with the supplied clock, but excludes queue wait", () => {
  const statistics = sessionStatistics(
    snapshot(
      [],
      [
        task({ status: "waiting", finishedAt: null }),
        task({
          id: "task-2",
          status: "queued",
          startedAt: null,
          finishedAt: null,
        }),
      ],
    ),
    Date.parse("2026-09-16T10:01:05.000Z"),
  );

  expect(statistics.totalRunMs).toBe(65000);
  expect(statistics.taskCountsByStatus.queued).toBe(1);
  expect(statistics.activeTask).toBe(true);
  expect(formatDuration(statistics.totalRunMs)).toBe("1 分 5 秒");
  expect(formatTokenCount(12345)).toBe("12,345");
});
