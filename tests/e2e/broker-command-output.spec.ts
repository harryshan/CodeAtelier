/**
 * 验证获批宿主命令的输出在真实浏览器时间线中可见，不启动模型或宿主命令。
 * 1. 合成持久化 Snapshot 和增量 SSE 刷新，先提供执行中 stdout/stderr，再提供工具终态。
 * 2. 各用例检查同一卡片中的实时输出、退出码/截断/错误，以及刷新后的历史重建。
 * 3. 无流式事件的旧结果使用最终 output 兜底；内容只作文本，不执行输出中的 HTML。
 * 路由只替换测试会话接口，沿用测试服务的 bootstrap 与实际 UI，不提供 Sandbox 验收证明。
 */

import { expect, test } from "@playwright/test";
import type { Event, Snapshot } from "../../src/shared/types.js";

const cases = [
  {
    name: "success",
    result: { exitCode: 0 },
    status: "退出码：0",
    stream: true,
  },
  {
    name: "nonzero",
    result: { exitCode: 7, truncated: true },
    status: "退出码：7；输出已截断",
    stream: true,
  },
  {
    name: "cancelled",
    result: { error: "命令已取消" },
    status: "错误：命令已取消",
    stream: true,
  },
  {
    name: "final-only",
    result: { exitCode: 0 },
    status: "退出码：0",
    stream: false,
  },
];

for (const scenario of cases) {
  test(`shows Broker command ${scenario.name} output live and after reload`, async ({
    page,
  }) => {
    const createdAt = "2026-10-09T00:00:00.000Z";
    const session = {
      id: "broker-output",
      workspace: "/broker-output",
      title: "宿主命令输出",
      titleState: "completed" as const,
      createdAt,
      updatedAt: createdAt,
    };
    const callId = "broker-call";
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
    append("tool_start", {
      name: "run_with_permissions",
      callId,
      args: { command: "example-command", reason: "测试宿主命令输出" },
    });
    append("tool_state", { callId, state: "executing" });
    const output = "stdout <b>plain text</b>\nstderr diagnostic\n";
    if (scenario.stream) {
      append("capability_output", {
        callId,
        text: "stdout <b>plain text</b>\n",
      });
      append("capability_output", { callId, text: "stderr diagnostic\n" });
    }

    const liveCount = events.length;
    append("tool_result", {
      name: "run_with_permissions",
      callId,
      result: { ...scenario.result, output },
      durationMs: 120,
    });
    const base: Snapshot = {
      session,
      events: [],
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
    let finished = false;
    await page.route("**/api/sessions", (route) =>
      route.fulfill({ json: [session] }),
    );
    await page.route(/\/api\/sessions\/broker-output(?:\?.*)?$/, (route) => {
      const after = Number(
        new URL(route.request().url()).searchParams.get("after") ?? 0,
      );
      const available = finished ? events : events.slice(0, liveCount);

      return route.fulfill({
        json: {
          ...base,
          events: available.filter((event) => event.id > after),
        },
      });
    });
    await page.route("**/api/sessions/broker-output/events", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: "event: refresh\ndata: {}\n\n",
      }),
    );

    await page.goto("/");
    await page
      .getByRole("button", { name: session.title, exact: true })
      .click();
    const card = page.locator("details").filter({
      has: page.locator("summary code", { hasText: "example-command" }),
    });
    await expect(card).toHaveCount(1);
    await expect(card.locator("summary")).toContainText("正在执行");
    if (scenario.stream) {
      await expect(card.locator("pre")).toHaveText(output);
    }

    await expect(card.getByText(scenario.status, { exact: true })).toHaveCount(
      0,
    );

    finished = true;
    await expect(card).toContainText(scenario.status);
    await expect(card.locator("pre")).toHaveText(output);
    await expect(card.locator("pre b")).toHaveCount(0);
    await expect(page.getByText("✓ 工具结果", { exact: true })).toHaveCount(0);

    await page.reload();
    await page
      .getByRole("button", { name: session.title, exact: true })
      .click();
    await expect(card).toHaveCount(1);
    await expect(card.locator("pre")).toHaveText(output);
    await expect(card).toContainText(scenario.status);
  });
}
