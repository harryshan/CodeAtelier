import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
test("create a session, edit a file, inspect diff and reload history", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );
  await page.goto("/");
  await expect(page.getByText("让想法，")).toBeVisible();
  await page.screenshot({ path: "test-results/welcome.png", fullPage: true });
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("项目目录").fill(workspace);
  await page.getByLabel("会话名称").fill("文件修改验收");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByLabel("任务描述").fill("修改文件");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(page.getByText("修改预览")).toBeVisible();
  expect(await readFile(path.join(workspace, "result.txt"), "utf8")).toContain(
    "CodeAtelier verified",
  );
  await page.screenshot({
    path: "test-results/conversation.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "文件修改验收" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  expect(errors).toEqual([]);
});
test("command approval survives refresh and can be denied or cancelled", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("项目目录").fill(workspace);
  await page.getByLabel("会话名称").fill("权限验收");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByLabel("任务描述").fill("执行命令");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("允许这次操作？")).toBeVisible();
  await page.screenshot({ path: "test-results/approval.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "权限验收" }).click();
  await expect(page.getByText("允许这次操作？")).toBeVisible();
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await page.getByLabel("任务描述").fill("执行命令");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("允许这次操作？")).toBeVisible();
  await page.getByRole("button", { name: "停止任务" }).click();
  await expect(page.getByText("任务已取消。")).toBeVisible();
  await expect(page.getByText("允许这次操作？")).toHaveCount(0);
});
test("settings validates and saves without exposing key", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "模型与设置" }).click();
  await page.getByLabel("API key", { exact: true }).fill("ui-test-secret");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const response = await page.request.get("/api/settings");
  expect(await response.text()).not.toContain("ui-test-secret");
});
