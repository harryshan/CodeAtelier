/**
 * 验证非正常终态在真实 App 中默认折叠过程，不访问真实模型或个人历史。
 * 1. installHistory 提供终态任务及可选续聊的合成快照与只读 SSE 响应。
 * 2. 参数用例覆盖 failed/cancelled/interrupted，输入及已有完整回复仍可见。
 * 3. 通知和未完成回复可展开读取；重载默认收起，中断提示与恢复按钮不被隐藏。
 * 4. 续聊后中断提示仍在原任务末尾，刷新不漂移，旧任务不再占用输入框恢复入口。
 */
import { expect, test, type Page } from "@playwright/test";
import type { Event, Snapshot, TaskStatus } from "../../src/shared/types.js";

async function installHistory(
  page: Page,
  status: TaskStatus,
  continued = false,
) {
  const createdAt = "2026-10-13T00:00:00.000Z";
  const session = {
    id: "terminal-history",
    title: "非正常结束",
    titleState: "completed" as const,
    workspace: "/terminal-test",
    createdAt,
    updatedAt: createdAt,
  };
  const records = [
    { type: "user", data: { text: "我的任务请求" } },
    { type: "notice", data: { text: "执行过程详情" } },
    ...(status === "failed"
      ? [{ type: "assistant", data: { text: "最后一条完整回复", step: 1 } }]
      : []),
    { type: "delta", data: { text: "尚未完成的文本", step: 2, attempt: 1 } },
  ];
  const events: Event[] = records.map((record, index) => ({
    ...record,
    id: index + 1,
    sessionId: session.id,
    taskId: "t",
    createdAt,
  }));
  const body: Snapshot = {
    session,
    events,
    approvals: [],
    tasks: [
      {
        id: "t",
        sessionId: session.id,
        status,
        subagentsEnabled: false,
        createdAt,
        error: "任务结束原因",
      },
    ],
  };
  if (continued) {
    body.tasks.push({
      ...body.tasks[0],
      id: "next",
      status: "completed",
      error: undefined,
    });
    body.events.push({
      id: events.length + 1,
      sessionId: session.id,
      taskId: "next",
      type: "user",
      data: { text: "后续任务请求" },
      createdAt,
    });
  }

  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route(/\/api\/sessions\/terminal-history(?:\?.*)?$/, (route) =>
    route.fulfill({ json: body }),
  );
  await page.route("**/api/sessions/terminal-history/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: session.title, exact: true }).click();
}

test("keeps historical interruption before the next task across reload", async ({
  page,
}) => {
  await installHistory(page, "interrupted", true);
  for (let visit = 0; visit < 2; visit++) {
    if (visit > 0) {
      await page.reload();
      await page
        .getByRole("button", { name: "非正常结束", exact: true })
        .click();
    }

    const notice = page.locator('[data-timeline-key="interrupted:t"]');
    await expect(notice).toBeVisible();
    await expect(page.getByText("后续任务请求", { exact: true })).toBeVisible();
    const items = await page
      .locator("[data-timeline-key]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-timeline-key")),
      );
    expect(items.indexOf("interrupted:t")).toBeLessThan(
      items.indexOf("event:4"),
    );
    await expect(
      page.getByRole("button", { name: "恢复任务", exact: true }),
    ).toHaveCount(0);
  }
});

for (const status of ["failed", "cancelled", "interrupted"] as const) {
  test(`collapses ${status} history without hiding recovery or losing process text`, async ({
    page,
  }) => {
    await installHistory(page, status);
    for (let visit = 0; visit < 2; visit++) {
      if (visit > 0) {
        await page.reload();
        await page
          .getByRole("button", { name: "非正常结束", exact: true })
          .click();
      }

      await expect(
        page.getByText("我的任务请求", { exact: true }),
      ).toBeVisible();
      if (status === "failed") {
        await expect(
          page.getByText("最后一条完整回复", { exact: true }),
        ).toBeVisible();
      }

      if (status === "interrupted") {
        await expect(
          page.getByText(
            "此任务因服务重启而中断。可继续提问；不会自动重放命令。",
            { exact: true },
          ),
        ).toBeVisible();
      }

      await expect(
        page.getByText("任务结束原因", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "恢复任务", exact: true }),
      ).toBeVisible();
      const groups = page.locator("[data-task-process]");
      await expect(groups).toHaveCount(status === "failed" ? 2 : 1);
      await expect(
        page.getByText("执行过程详情", { exact: true }),
      ).toBeHidden();
      await expect(
        page.getByText("尚未完成的文本", { exact: true }),
      ).toBeHidden();
      for (const group of await groups.all()) {
        await group.locator(":scope > summary").click();
      }

      await expect(
        page.getByText("执行过程详情", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("尚未完成的文本", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("未完成的回复", { exact: true }),
      ).toBeVisible();
    }
  });
}
