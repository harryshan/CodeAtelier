/**
 * 浏览器验证显式 Worktree 对话的创建、项目分组、真实文件修改与历史重载。
 * 1. 临时 Git 仓库提供已提交基线和脏文件；用户显式选择 Worktree，无需 CoW helper，经生产 HTTP 创建 checkout。
 * 2. 固定测试模型执行真实 edit_files，断言产物仅出现在新目录，刷新仍显示同一对话。
 * 3. 退役 Riftri 的合成历史验证提示、禁用恢复/提交和保留草稿；真正拒绝执行由 HTTP/Engine 测试覆盖。
 * 4. finally 通过 Git 删除本用例创建的 checkout，再删除唯一临时来源目录；不操作用户仓库。
 * 测试使用普通宿主执行，不能作为 Windows/MXC 安装态 Sandbox 验收。
 */

import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../../src/worktrees/git.js";
import type { Session } from "../../src/shared/types.js";

test("retired Riftri history stays readable without allowing execution", async ({
  page,
}) => {
  const session: Session = {
    id: "retired-ui",
    workspace: "C:\\retired-workspace",
    title: "退役私有对话",
    titleState: "completed",
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    worktree: {
      id: "legacy-view",
      mode: "retired",
      state: "retired",
      projectWorkspace: "C:\\source",
    },
  };
  const task = {
    id: "retired-task",
    sessionId: session.id,
    status: "interrupted",
    createdAt: session.createdAt,
    subagentsEnabled: false,
  };
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route(/\/api\/sessions\/retired-ui(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { session, tasks: [task], events: [], approvals: [] },
    }),
  );
  await page.route("**/api/sessions/retired-ui/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(sessions|tasks)/.test(request.url())
    ) {
      writes.push(request.url());
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: session.title, exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Riftri" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "恢复任务", exact: true }),
  ).toBeDisabled();
  const editor = page.getByLabel("任务描述");
  await editor.fill("保留草稿");
  await expect(page.getByRole("button", { name: "开始执行" })).toBeDisabled();
  await editor.press("Enter");
  await expect(editor).toContainText("保留草稿");
  expect(writes).toEqual([]);
});

test("creates a worktree conversation, edits there and reloads its history", async ({
  page,
}) => {
  const source = await realpath(
    await mkdtemp(path.join(tmpdir(), "ca-worktree-ui-")),
  );
  let checkout: string | undefined;
  try {
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.name", "UI Fixture"]);
    await git(source, ["config", "user.email", "ui@example.invalid"]);
    await writeFile(path.join(source, "tracked.txt"), "base\n");
    await git(source, ["add", "."]);
    await git(source, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ]);
    await writeFile(path.join(source, "tracked.txt"), "local dirty\n");

    await page.goto("/");
    await page.getByLabel("项目目录").fill(source);
    await page.getByRole("button", { name: "改用 Git worktree" }).click();
    const project = page.getByRole("group", { name: source, exact: true });
    const dialog = page.getByRole("dialog", { name: "新建 Worktree 对话" });
    await expect(dialog.getByText("起始分支或 commit")).toBeVisible();
    await dialog.getByLabel("起始分支或 commit").fill("refs/heads/main");
    await page.screenshot({
      path: "test-results/worktree-create.png",
      fullPage: true,
    });
    const response = page.waitForResponse(
      (item) =>
        item.url().endsWith("/api/sessions") &&
        item.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "创建 Worktree", exact: true })
      .click();
    const session = (await (await response).json()) as Session;
    checkout = session.workspace;
    expect(checkout).toBeTruthy();
    expect(session.worktree?.projectWorkspace).toBe(source);
    await expect(dialog).toBeHidden();
    await expect(page.getByText(checkout, { exact: true })).toBeVisible();
    expect(await readFile(path.join(checkout, "tracked.txt"), "utf8")).toBe(
      "base\n",
    );
    await page.getByLabel("任务描述").fill("修改文件");
    await page.getByRole("button", { name: "开始执行" }).click();
    await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
    expect(await readFile(path.join(checkout, "result.txt"), "utf8")).toContain(
      "CodeAtelier verified",
    );
    await expect(readFile(path.join(source, "result.txt"))).rejects.toThrow();
    expect(await readFile(path.join(source, "tracked.txt"), "utf8")).toBe(
      "local dirty\n",
    );

    await page.reload();
    await project
      .getByRole("button", { name: "修改文件", exact: true })
      .click();
    await expect(page.getByText(checkout, { exact: true })).toBeVisible();
    await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
    await page.screenshot({
      path: "test-results/worktree-conversation.png",
      fullPage: true,
    });
    await expect(
      page.getByRole("group", { name: checkout, exact: true }),
    ).toHaveCount(0);
  } finally {
    if (checkout) {
      // Only the checkout returned by this fixture's successful creation can be removed.
      await git(source, ["worktree", "remove", "--force", "--", checkout]);
    }

    await rm(source, { recursive: true, force: true });
  }
});
