/**
 * 阅读器数据库模式的 Chromium 回归：真实服务用例经正常 API 保存任务，再通过 UI 查看，另以合成响应验证竞态。
 * 1. 真实链路验证对话/Task 选择、模型记录、刷新恢复和空对话，浏览操作不提交任务。
 * 2. 控制只读响应验证晚到的任务详情不覆盖新选择、404 读取错误清空旧记录且可手动重试。
 * 3. 模拟空库及无效深链接，避免悄悄显示其他会话；只保存 IDs，不向 URL/localStorage 写正文。
 * 使用临时项目和测试服务模拟模型，不读个人 SQLite 或真实导出，不运行 Evaluation。
 */

import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { viewerFixture } from "../fixtures/replay-viewer.js";

async function expectTaskReply(page: Page) {
  // 新会话会先捕获 title 调用；通过目录导航到 task，而不是把第一条记录误当主模型。
  await page
    .getByRole("navigation", { name: "记录目录" })
    .getByRole("button", { name: /模型调用 #\d+ · task/ })
    .last()
    .click();
  await expect(page.getByRole("article")).toContainText(
    "任务完成，已检查工具结果。",
  );
}

test("browses saved conversations and tasks from the real database without exporting", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-replay-db-")),
  );
  try {
    const auth = await page.request.get("/api/bootstrap");
    const { token } = await auth.json();
    const headers = { "x-codeatelier-token": token };
    const created = await page.request.post("/api/sessions", {
      headers,
      data: { workspace },
    });
    const session = await created.json();
    const empty = await (
      await page.request.post("/api/sessions", { headers, data: { workspace } })
    ).json();
    const task = await (
      await page.request.post(`/api/sessions/${session.id}/tasks`, {
        headers,
        data: { prompt: "数据库阅读测试" },
      })
    ).json();
    await expect
      .poll(async () => {
        const list = await (
          await page.request.get(`/api/sessions/${session.id}/tasks`)
        ).json();

        return list.find((item: { id: string }) => item.id === task.id)?.status;
      })
      .toBe("completed");
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") {
        writes.push(request.url());
      }
    });
    await page.goto(`/?view=replay&session=${session.id}&task=${task.id}`);
    await expect(page.getByLabel("选择对话", { exact: true })).toHaveValue(
      session.id,
    );
    await expect(page.getByLabel("选择 Task", { exact: true })).toHaveValue(
      task.id,
    );
    await expectTaskReply(page);
    await expect(page.getByLabel("任务概览")).toContainText("captured");
    await page.reload();
    await expectTaskReply(page);
    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "已读取当前已保存记录",
    );
    await page.getByLabel("选择对话", { exact: true }).selectOption(empty.id);
    await expect(page.getByRole("status")).toContainText("这个对话还没有 Task");
    await expect(page.getByRole("article")).not.toContainText(
      "任务完成，已检查工具结果。",
    );
    await page.getByLabel("选择对话", { exact: true }).selectOption(session.id);
    await expectTaskReply(page);
    const second = await (
      await page.request.post(`/api/sessions/${session.id}/tasks`, {
        headers,
        data: { prompt: "第二个数据库任务" },
      })
    ).json();
    await expect
      .poll(async () => {
        const list = await (
          await page.request.get(`/api/sessions/${session.id}/tasks`)
        ).json();

        return list.find((item: { id: string }) => item.id === second.id)
          ?.status;
      })
      .toBe("completed");
    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await page.getByLabel("选择 Task", { exact: true }).selectOption(second.id);
    await expect(page.getByLabel("任务概览")).toContainText(
      `任务 ${second.id}`,
    );
    await page.getByLabel("选择 Task", { exact: true }).selectOption(task.id);
    await expect(page.getByLabel("任务概览")).toContainText(`任务 ${task.id}`);
    expect(writes).toEqual([]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ignores stale details and clears prior data on a failed read before retry", async ({
  page,
}) => {
  const conversation = {
    id: "session-a",
    title: "合成对话",
    workspace: "example",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    titleState: "manual",
  };
  const task = (id: string) => ({
    id,
    sessionId: conversation.id,
    status: "completed",
    createdAt: "2026-01-01",
    subagentsEnabled: false,
  });
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [conversation] }),
  );
  await page.route("**/api/sessions/session-a/tasks", (route) =>
    route.fulfill({ json: [task("slow"), task("fast")] }),
  );
  let release!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/tasks/slow/replay", async (route) => {
    arrived();
    await gate;
    await route
      .fulfill({ json: { ...viewerFixture(), task: task("slow") } })
      .catch(() => {});
  });
  let fail = false;
  await page.route("**/tasks/fast/replay", (route) =>
    route.fulfill(
      fail
        ? { status: 404, json: { error: "记录已不存在" } }
        : { json: { ...viewerFixture(), task: task("fast") } },
    ),
  );
  await page.goto("/?view=replay&session=session-a&task=slow");
  await waiting;
  await page.getByLabel("选择 Task", { exact: true }).selectOption("fast");
  await expect(page.getByLabel("任务概览")).toContainText("任务 fast");
  release();
  await expect(page.getByLabel("任务概览")).not.toContainText("任务 slow");
  fail = true;
  await page.getByRole("button", { name: "刷新记录", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "记录已不存在" }),
  ).toBeVisible();
  await expect(page.getByLabel("任务概览")).not.toContainText("任务 fast");
  fail = false;
  await page.getByRole("button", { name: "刷新记录", exact: true }).click();
  await expect(page.getByLabel("任务概览")).toContainText("任务 fast");
});

test("shows empty databases and rejects missing conversation deep links", async ({
  page,
}) => {
  await page.route("**/api/sessions", (route) => route.fulfill({ json: [] }));
  await page.goto("/?view=replay");
  await expect(page.getByRole("status")).toContainText("数据库中还没有对话");
  await page.goto("/?view=replay&session=missing&task=missing");
  await expect(
    page.getByRole("alert").filter({ hasText: "所选对话不存在" }),
  ).toBeVisible();
  await expect(page.getByLabel("任务概览")).toBeEmpty();
});
