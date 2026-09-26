/**
 * 浏览器中的大历史与增量重连回归，使用真实前端和本地测试服务的 bootstrap。
 * 1. HTTP 路由提供合成会话、12,000 个工具事件和有序增量，不调用模型或操作项目文件。
 * 2. 关闭的 SSE 响应促使真实 EventSource 重连，检查游标、重复事件去重和最终回复。
 * 3. 滚动与输入期间保持有限挂载节点，统计从 2,000 次工具调用保持不重复累计。
 * 耗时仅作为浏览器诊断输出，不用机器相关毫秒阈值决定测试通过。
 */

import { expect, test } from "@playwright/test";
import type { Event, Snapshot } from "../../src/shared/types.js";

test("keeps long history responsive and merges reconnect deltas once", async ({
  page,
}) => {
  const createdAt = "2026-09-26T00:00:00.000Z";
  const session = {
    id: "frontend-perf",
    workspace: "/frontend-perf",
    title: "长历史性能",
    titleState: "completed" as const,
    createdAt,
    updatedAt: createdAt,
  };
  const events: Event[] = [];
  const append = (type: string, data: unknown) =>
    events.push({
      id: events.length + 1,
      sessionId: session.id,
      taskId: "task",
      type,
      data,
      createdAt,
    });
  for (let index = 0; index < 2000; index++) {
    const callId = String(index);
    append("tool_start", {
      name: "run_command",
      callId,
      args: { command: "example" },
    });
    append("tool_state", { callId, state: "queued" });
    append("tool_state", { callId, state: "executing" });
    append("command_output", { callId, text: "example output\n" });
    append("tool_state", { callId, state: "succeeded" });
    append("tool_result", {
      name: "run_command",
      callId,
      result: { exitCode: 0 },
    });
  }

  append("delta", { step: 1, text: "正在接收" });
  const base: Snapshot = {
    session,
    events,
    approvals: [],
    tasks: [
      {
        id: "task",
        sessionId: session.id,
        status: "running",
        subagentsEnabled: false,
        createdAt,
        startedAt: createdAt,
        finishedAt: null,
      },
    ],
  };
  const completed = {
    id: events.length + 1,
    sessionId: session.id,
    taskId: "task",
    type: "assistant",
    data: { step: 1, text: "合并后的最终回复" },
    createdAt,
  };
  const errors: string[] = [];
  const cursors: number[] = [];
  let deliverFinal = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route(/\/api\/sessions\/frontend-perf(?:\?.*)?$/, (route) => {
    const after = Number(
      new URL(route.request().url()).searchParams.get("after") ?? 0,
    );
    cursors.push(after);

    return route.fulfill({
      json: {
        ...base,
        events:
          after === 0 ? events : deliverFinal ? [events.at(-1), completed] : [],
      },
    });
  });
  await page.route("**/api/sessions/frontend-perf/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  const begin = Date.now();
  await page.getByRole("button", { name: session.title, exact: true }).click();
  await expect(page.getByText("正在接收", { exact: true })).toBeVisible();
  const initialMs = Date.now() - begin;
  const area = page.locator('[class*="scrollArea"]');
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator('[data-timeline-placeholder="after"]')).toHaveCount(
    1,
  );
  expect(await page.locator("[data-timeline-key]").count()).toBeLessThan(30);
  await page.getByLabel("任务描述").fill("长历史期间仍可编辑");
  await expect(page.getByLabel("任务描述")).toHaveText("长历史期间仍可编辑");
  deliverFinal = true;
  await expect.poll(() => cursors.length).toBeGreaterThan(1);
  await area.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    page.getByText("合并后的最终回复", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("正在接收", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "展开会话统计" }).click();
  await expect(page.getByText("2000 次", { exact: true })).toBeVisible();
  await expect(
    page.getByText("成功 2000/2000（100%）", { exact: true }),
  ).toBeVisible();
  const previousRequests = cursors.length;
  await expect.poll(() => cursors.length).toBeGreaterThan(previousRequests);
  await expect(page.getByText("2000 次", { exact: true })).toBeVisible();
  expect(cursors.slice(1).every((cursor) => cursor >= events.length)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  console.info(
    `frontend history: 12001 initial events, visible nodes=${await page.locator("[data-timeline-key]").count()}, initial view=${initialMs}ms`,
  );
});
