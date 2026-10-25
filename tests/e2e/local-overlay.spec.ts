/**
 * 隔离 Local 的浏览器契约验证，使用合成 HTTP/SSE，不挂载文件系统或运行 Sandbox。
 * 1. 固定创建 UUID 的错误/重试、模式参数、来源项目归组和刷新后私有状态展示。
 * 2. 后端能力拒绝阻止提交，合成已发布/拒绝/不可用状态不能被模型完成文本覆盖。
 * 页面和请求代码为生产实现；真实挂载/权限/发布链路另由手动 WinFsp 验证证明。
 */
import { expect, test } from "@playwright/test";
import type { Session } from "../../src/shared/types.js";

const source = "/local-overlay-source";
const created: Session = {
  id: "local-overlay-ui",
  title: "私有并行对话",
  titleState: "completed",
  workspace: "/private/local-overlay-ui",
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
  localOverlay: { id: "view", projectWorkspace: source, state: "ready" },
};

test("retries the same explicit Local request and keeps source grouping after reload", async ({
  page,
}) => {
  const requests: any[] = [];
  let sessions: Session[] = [];
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        localOverlayCreation: { enabled: true },
      },
    });
  });
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        await route.fulfill({
          status: 409,
          json: { error: "创建结果未确认，请重试同一请求。" },
        });
      } else {
        sessions = [created];
        await route.fulfill({ json: created });
      }
    } else {
      await route.fulfill({ json: sessions });
    }
  });
  await page.route(/\/api\/sessions\/local-overlay-ui(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { session: created, tasks: [], events: [], approvals: [] },
    }),
  );
  await page.route("**/api/sessions/local-overlay-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await page.getByLabel("项目目录").fill(source);
  await page
    .getByRole("button", { name: "使用隔离 Local", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建隔离 Local 对话" });
  await expect(dialog.getByText(/无需 Git 仓库/)).toBeVisible();
  await page.screenshot({
    path: "test-results/local-overlay-create.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "创建隔离 Local", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("创建结果未确认");
  await dialog.getByRole("button", { name: "重试同一请求" }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toEqual({
    workspace: source,
    localOverlay: { id: expect.any(String) },
  });
  await expect(page.getByText("隔离 Local", { exact: true })).toBeVisible();
  await expect(page.getByText(/尚无源码发布记录/)).toBeVisible();
  const project = page.getByRole("group", { name: source, exact: true });
  await expect(
    project.getByRole("button", { name: created.title, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/local-overlay-private.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: created.title, exact: true }).click();
  await expect(
    page.getByText(created.workspace, { exact: true }),
  ).toBeVisible();
  await expect(
    project.getByRole("button", { name: "新建隔离 Local 对话", exact: true }),
  ).toBeVisible();
});

test("disables unsupported creation and distinguishes retained from published history", async ({
  page,
}) => {
  let session = structuredClone(created);
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        localOverlayCreation: {
          enabled: false,
          reason: "隔离 Local 当前需要启用 Sandbox。",
        },
      },
    });
  });
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route(/\/api\/sessions\/local-overlay-ui(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { session, tasks: [], events: [], approvals: [] } }),
  );
  await page.route("**/api/sessions/local-overlay-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "新建隔离 Local 对话", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新建隔离 Local 对话" });
  await expect(dialog.getByText(/需要启用 Sandbox/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "创建隔离 Local", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  for (const state of [
    "selected",
    "published",
    "rejected",
    "retained",
  ] as const) {
    session = {
      ...created,
      localOverlay: {
        ...created.localOverlay!,
        publication: { state, files: 2 },
      },
    };
    await page.reload();
    await page
      .getByRole("button", { name: created.title, exact: true })
      .click();
    const expected = {
      selected: "已登记源码选择，尚未发布。",
      published: "所选源码已发布（2 个文件）",
      rejected: "来源冲突或验证未通过",
      retained: "本轮未发布，私有修改已保留。",
    }[state];
    await expect(page.getByText(expected, { exact: false })).toBeVisible();
  }

  session = { ...created, localOverlay: { id: "view", state: "unavailable" } };
  await page.reload();
  await page.getByRole("button", { name: created.title, exact: true }).click();
  await expect(page.getByText(/私有视图需要核查/)).toBeVisible();
  await page.getByLabel("任务描述").fill("不应执行");
  await expect(page.getByRole("button", { name: "开始执行" })).toBeDisabled();
});
