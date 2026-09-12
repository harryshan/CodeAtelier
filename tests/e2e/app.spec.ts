/**
 * 文件作用：通过浏览器验证用户可观察的完整会话交互。
 *
 * 使用场景与输入输出：
 * 由 Playwright 启动 tests/fixtures/server.ts，以 Chromium 操作真实页面和临时工作区，模型行为来自固定替身。
 *
 * 代码结构与阅读顺序：
 * 1. 前半部分覆盖建会话、写文件及 diff、刷新历史、审批拒绝或取消、设置保存。
 * 2. 中间验证重试文本分离、SSE 凭据失效后的重连和多个会话的隔离。
 * 3. 关闭场景分别覆盖确认成功与请求失败时的不确定提示。
 * 4. 末尾核对上下文压缩通知、原始历史和实际 usage 在刷新后的展示。
 *
 * 维护注意事项：
 * 浏览器断线或刷新不能重新提交任务；用例不依赖个人模型密钥，也不证明真实服务质量。
 */

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

  await expect(page.getByRole("button", { name: "恢复任务" })).toBeVisible();
  await expect(page.getByText("允许这次操作？")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "权限验收" }).click();
  await page.getByRole("button", { name: "恢复任务" }).click();

  await expect(page.getByText("允许这次操作？")).toBeVisible();
  await page.getByRole("button", { name: "拒绝", exact: true }).click();

  await expect(page.getByRole("button", { name: "恢复任务" })).toHaveCount(0);
});

test("settings validates and saves without exposing key", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "模型与设置" }).click();
  await expect(page.getByLabel("思考等级")).toHaveValue("high");
  await page.getByLabel("思考等级").selectOption("medium");
  await page.getByLabel("API key", { exact: true }).fill("ui-test-secret");
  await page.getByRole("button", { name: "保存设置" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  const response = await page.request.get("/api/settings");

  const saved = await response.text();
  expect(saved).not.toContain("ui-test-secret");
  expect(JSON.parse(saved).settings.reasoningEffort).toBe("medium");
  await page.reload();
  await page.getByRole("button", { name: "模型与设置" }).click();
  await expect(page.getByLabel("思考等级")).toHaveValue("medium");
  await page.screenshot({ path: "test-results/settings.png", fullPage: true });
  await page.getByLabel("思考等级").selectOption("high");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("model retries keep incomplete text separate from the successful response", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("项目目录").fill(workspace);
  await page.getByLabel("会话名称").fill("重试验收");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByLabel("任务描述").fill("模型重试");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(page.getByText("第一次尝试的部分回复")).toBeVisible();
  await expect(page.getByText("未完成的回复")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "后重试" }),
  ).toBeVisible();
});

test("reconnects after an expired SSE session without resubmitting a task", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );
  let connections = 0;

  await page.route("**/api/sessions/*/events", async (route) => {
    if (++connections === 1) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":"expired"}',
      });
    } else {
      await route.continue();
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("项目目录").fill(workspace);
  await page.getByLabel("会话名称").fill("重连验收");
  await page.getByRole("button", { name: "创建会话" }).click();

  await expect.poll(() => connections).toBeGreaterThan(1);
  await expect(page.getByText("就绪", { exact: true })).toBeVisible();
  const sessions = await (await page.request.get("/api/sessions")).json();
  const session = sessions.find(
    (s: { title: string }) => s.title === "重连验收",
  );
  const snapshot = await (
    await page.request.get("/api/sessions/" + session.id)
  ).json();

  expect(snapshot.tasks).toHaveLength(0);
});

test("continues a historical conversation while keeping another session isolated", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );

  await page.goto("/");
  for (const title of ["续聊会话", "独立会话"]) {
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("项目目录").fill(workspace);
    await page.getByLabel("会话名称").fill(title);
    await page.getByRole("button", { name: "创建会话" }).click();
    if (title === "续聊会话") {
      await page.getByLabel("任务描述").fill("说明项目");
      await page.getByRole("button", { name: "开始执行" }).click();

      await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
    }
  }

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "续聊会话" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(1);
  await page.getByLabel("任务描述").fill("继续说明");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(2);
  await page.getByRole("button", { name: "独立会话" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(0);
});

test("shutdown requires confirmation and displays restart instructions", async ({
  page,
}) => {
  let requested = 0;

  await page.route("**/api/server/shutdown", async (route) => {
    requested++;

    expect(route.request().postDataJSON()).toEqual({ confirm: true });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "关闭服务", exact: true }).click();

  await expect(
    page.getByRole("dialog", { name: "关闭服务确认" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂不关闭" }).click();

  expect(requested).toBe(0);
  await page.getByRole("button", { name: "关闭服务", exact: true }).click();
  await page.getByRole("button", { name: "确认关闭服务" }).click();

  await expect(page.getByRole("heading", { name: "服务已关闭" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新连接", exact: true }),
  ).toBeVisible();
  expect(requested).toBe(1);
});

test("shutdown request failure reports uncertainty and keeps the interface usable", async ({
  page,
}) => {
  await page.route("**/api/server/shutdown", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"unavailable"}',
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "关闭服务", exact: true }).click();
  await page.getByRole("button", { name: "确认关闭服务" }).click();

  await expect(page.getByRole("alert")).toContainText("未能确认关闭结果");
  await expect(
    page.getByRole("button", { name: "关闭服务", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("heading", { name: "服务已关闭" })).toHaveCount(
    0,
  );
});

test("context compression notice and original history survive refresh", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("项目目录").fill(workspace);
  await page.getByLabel("会话名称").fill("压缩验收");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByLabel("任务描述").fill("准备上下文压缩");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("已准备长历史。", { exact: true })).toBeVisible();
  await page.getByLabel("任务描述").fill("继续，保持原任务要求");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText(/上下文已整理：/)).toBeVisible();
  await expect(
    page.getByText("任务完成，已检查工具结果。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "压缩验收" }).click();
  await expect(page.getByText("准备上下文压缩", { exact: true })).toBeVisible();
  await expect(page.getByText("已准备长历史。", { exact: true })).toBeVisible();
  await expect(page.getByText(/上下文已整理：/)).toBeVisible();
});

test("shows discovered token budget and persisted actual usage", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByLabel("项目目录").fill(workspace);
  await page.getByLabel("会话名称").fill("Token 验收");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByLabel("任务描述").fill("说明项目");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(
    page.getByText("上下文预算：token 模式", { exact: true }),
  ).toBeVisible();
  await page.getByText("上下文预算：token 模式", { exact: true }).click();
  await expect(
    page.getByText("服务公布窗口：372000 token", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("模型用量（服务实报）：输入 100 / 输出 20 token", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Token 验收" }).click();
  await expect(
    page.getByText("模型用量（服务实报）：输入 100 / 输出 20 token", {
      exact: true,
    }),
  ).toBeVisible();
});
