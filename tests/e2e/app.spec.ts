/**
 * 用 Chromium 操作真实页面，检查用户完成会话任务时看到的结果。
 * Playwright 启动本地测试服务器和临时工作区，模型响应由 tests/fixtures/server.ts 模拟。
 *
 * 1. 创建会话、通过统一文件编辑创建文件、查看 diff、刷新历史，再检查审批、取消和设置保存。
 * 2. 检查重试文本分开显示且保持原始顺序、凭据失效后重新连接，以及会话切换后的数据隔离。
 * 3. 检查受确认的重载服务入口会等待替代服务、完整刷新页面，以及关闭服务成功和请求失败时的不同提示。
 * 4. 检查压缩通知、原始历史及模型用量在刷新后仍能显示。
 * 5. 验证多文件编辑的成功/失败状态、错误、diff 和刷新后的历史；命令和 Git 的流式输出、结果与历史重载聚合在同一卡片。
 * 6. 通过页面内项目目录连接首个项目，再从项目标题右侧加号新建对话并检查历史隔离、折叠与最近记录限制。
 * 7. 检查当前会话统计默认收起，展开后使用已保存事件显示 token、LLM、工具成功率、运行时间和已结束任务的 Perfetto 下载入口。
 * 8. 验证用户和 agent 消息的 Markdown 标题、链接、代码围栏、表格和任务列表渲染，并拒绝原始 HTML。
 * 9. 检查任务输入框以所见即所得方式将 Markdown 输入规则原地转换为富文本，并将生成的 Markdown 发送给任务。
 * 10. 已完成任务默认仅显示输入和最后一轮输出；中间工具、通知和重试文本收纳为可展开过程，未完成任务仍完整显示。
 * 11. 累积较长时间线后检查滚动窗口外只保留高度占位，滚动到另一端才创建对应消息节点。
 * 12. 在手机视口检查完整侧栏由菜单按钮打开，并可通过会话选择、遮罩或 Escape 关闭。
 *
 * 页面刷新或重连不能重新提交任务。这里不调用真实模型。
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function createInitialConversation(page: Page, workspace: string) {
  await page.getByLabel("项目目录").fill(workspace);
  await page.getByRole("button", { name: "连接项目并新建对话" }).click();
}

async function expandTaskProcess(page: Page) {
  await page
    .locator("[data-task-process]")
    .last()
    .locator(":scope > summary")
    .click();
}

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
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("修改文件");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(
    page.locator("article").filter({ hasText: "修改文件" }),
  ).toBeVisible();
  await expect(page.getByText(/展开任务过程（\d+ 项）/)).toBeVisible();
  await expect(page.getByText("修改预览")).toBeHidden();
  await expandTaskProcess(page);
  await expect(page.getByText("修改预览")).toBeVisible();
  expect(await readFile(path.join(workspace, "result.txt"), "utf8")).toContain(
    "CodeAtelier verified",
  );
  await page.screenshot({
    path: "test-results/conversation.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "修改文件" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(page.getByText("修改预览")).toBeHidden();
  await expandTaskProcess(page);
  await expect(page.getByText("修改预览")).toBeVisible();
  expect(errors).toEqual([]);
});

test("opens and closes the complete navigation drawer on a phone viewport", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-mobile-nav-")),
  );
  const menuButton = page.getByRole("button", { name: /导航菜单/ });
  const drawer = page.getByRole("complementary", { name: "项目与对话" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await createInitialConversation(page, workspace);

  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toBeHidden();
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toBeVisible();

  await drawer.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).toBeHidden();

  await menuButton.click();
  await page.getByRole("button", { name: "关闭导航抽屉" }).click();
  await expect(drawer).toBeHidden();

  await menuButton.click();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("renders persisted agent replies as safe GitHub Flavored Markdown", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );

  await page.goto("/");
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").pressSequentially("**用户 Markdown**");
  await page.getByRole("button", { name: "开始执行" }).click();

  const userMessage = page
    .locator("article")
    .filter({ hasText: "用户 Markdown" });
  const markdownReply = page
    .locator("article")
    .filter({ hasText: "Markdown 标题" });

  await expect(userMessage.locator("strong")).toHaveText("用户 Markdown");
  await expect(
    markdownReply.getByRole("heading", { name: "Markdown 标题" }),
  ).toBeVisible();
  await expect(markdownReply.locator("strong")).toHaveText("粗体");
  await expect(
    markdownReply.getByRole("link", { name: "CodeAtelier 官网" }),
  ).toHaveAttribute("href", "https://example.com/docs");
  await expect(markdownReply.locator("pre code")).toHaveText(
    "const answer = 42;\n",
  );
  await expect(markdownReply.getByRole("table")).toContainText("已渲染");
  await expect(markdownReply.getByRole("checkbox")).toBeChecked();
  await expect(markdownReply.locator("script")).toHaveCount(0);
  await expect(markdownReply).not.toContainText("markdownExecuted");

  await page.reload();
  await page.getByRole("button", { name: "**用户 Markdown**" }).click();
  await expect(
    page
      .locator("article")
      .filter({ hasText: "Markdown 标题" })
      .getByRole("table"),
  ).toContainText("已渲染");
});

test("converts task Markdown input rules into an in-place rich editor", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );
  const editor = page.getByRole("textbox", { name: "任务描述" });

  await page.goto("/");
  await createInitialConversation(page, workspace);
  await editor.pressSequentially("# ");
  await editor.pressSequentially("所见即所得标题");

  await expect(
    editor.getByRole("heading", { name: "所见即所得标题" }),
  ).toBeVisible();
  await expect(editor).not.toContainText("# 所见即所得标题");

  await editor.press("Shift+Enter");
  await editor.pressSequentially(" **粗体内容**");
  await expect(editor.locator("strong")).toHaveText("粗体内容");
  await expect(
    page.getByRole("region", { name: "Markdown 实时预览" }),
  ).toHaveCount(0);
});

test("keeps current session statistics collapsed until expanded and projects persisted usage", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );

  await page.goto("/");
  await createInitialConversation(page, workspace);
  await expect(
    page.getByRole("button", { name: "展开会话统计" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "会话统计" })).toHaveCount(0);
  await page.getByRole("button", { name: "展开会话统计" }).click();
  await expect(page.getByRole("heading", { name: "会话统计" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /下载任务 .* 的 Perfetto trace/ }),
  ).toHaveCount(0);
  await page.getByLabel("任务描述").fill("修改文件");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();

  await expect(page.getByRole("heading", { name: "会话统计" })).toBeVisible();
  await expect(page.getByText("Token（服务实报）")).toBeVisible();
  await expect(page.getByText("输入（缓存 / 非缓存）")).toBeVisible();
  await expect(page.getByText("工具分布：edit_files 1")).toBeVisible();
  await expect(page.getByText("成功 1/1（100%）")).toBeVisible();
  await expect(page.getByText("LLM 请求")).toBeVisible();
  await expect(page.getByText("明细未完整提供（输入合计 100）")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /下载任务 .* 的 Perfetto trace/ }),
  ).toHaveAttribute("href", /\/api\/tasks\/.*\/trace/);
});

test("command approval survives refresh and can be denied or cancelled", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );

  await page.goto("/");
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("执行命令");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("允许这次操作？")).toBeVisible();
  await page.screenshot({ path: "test-results/approval.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "执行命令" }).click();

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
  await page.getByRole("button", { name: "执行命令" }).click();
  await page.getByRole("button", { name: "恢复任务" }).click();

  await expect(page.getByText("允许这次操作？")).toBeVisible();
  await page.getByRole("button", { name: "拒绝", exact: true }).click();

  await expect(page.getByRole("button", { name: "恢复任务" })).toHaveCount(0);
});

test("groups streamed command output and its final status in one persistent card", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );

  await page.goto("/");
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("执行命令并查看输出");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("允许这次操作？")).toBeVisible();
  await page.getByRole("button", { name: "允许一次" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(page.getByText("VERIFIED", { exact: true })).toBeHidden();
  await expandTaskProcess(page);
  await expect(page.getByText("VERIFIED", { exact: true })).toBeVisible();
  await expect(page.getByText("退出码：0")).toBeVisible();
  await expect(
    page.locator("details details").filter({ hasText: "VERIFIED" }),
  ).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "执行命令并查看输出" }).click();

  await expect(page.getByText("VERIFIED", { exact: true })).toBeHidden();
  await expandTaskProcess(page);
  await expect(page.getByText("VERIFIED", { exact: true })).toBeVisible();
  await expect(
    page.locator("details details").filter({ hasText: "VERIFIED" }),
  ).toHaveCount(1);
});

test("groups Git output and its final status in one persistent card", async ({
  page,
}) => {
  const workspace = await realpath(process.cwd());

  await page.goto("/");
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("查看 Git 输出");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expandTaskProcess(page);
  const gitCard = page
    .locator("details details")
    .filter({ hasText: "Git 操作 status" });

  await expect(gitCard).toHaveCount(1);
  await expect(gitCard.getByText("退出码：0")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "查看 Git 输出" }).click();

  await expandTaskProcess(page);
  await expect(
    page.locator("details details").filter({ hasText: "Git 操作 status" }),
  ).toHaveCount(1);
});

test("settings show the environment connection and save preferences without exposing key", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "模型与设置" }).click();
  await expect(page.getByLabel("连接配置")).toContainText("test-model");
  await expect(page.getByLabel("思考等级")).toHaveValue("high");
  await page.getByLabel("思考等级").selectOption("medium");
  await page.getByLabel("辅助模型推理强度").selectOption("low");
  await page.getByLabel("API key", { exact: true }).fill("ui-test-secret");
  await page.getByRole("button", { name: "保存设置" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  const response = await page.request.get("/api/settings");

  const saved = await response.text();
  expect(saved).not.toContain("ui-test-secret");
  expect(JSON.parse(saved).settings.reasoningEffort).toBe("medium");
  expect(JSON.parse(saved).settings.auxiliaryModel).toBe("test-low-cost-model");
  await page.reload();
  await page.getByRole("button", { name: "模型与设置" }).click();
  await expect(page.getByLabel("思考等级")).toHaveValue("medium");
  await page.screenshot({ path: "test-results/settings.png", fullPage: true });
  await expect(page.getByLabel("连接配置")).toContainText(
    "test-low-cost-model",
  );
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
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("模型重试");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(page.getByText("第一次尝试的部分回复")).toBeHidden();
  await expect(page.getByText("未完成的回复")).toBeHidden();
  await expandTaskProcess(page);
  await expect(page.getByText("第一次尝试的部分回复")).toBeVisible();
  await expect(page.getByText("未完成的回复")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "后重试" }),
  ).toBeVisible();

  const timelineText = (
    await page.locator("[data-timeline-key]").allTextContents()
  ).join("\n");
  expect(timelineText.indexOf("第一次尝试的部分回复")).toBeLessThan(
    timelineText.indexOf("后重试"),
  );
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
  await createInitialConversation(page, workspace);

  await expect.poll(() => connections).toBeGreaterThan(1);
  await expect(page.getByText("就绪", { exact: true })).toBeVisible();
  const sessions = await (await page.request.get("/api/sessions")).json();
  const session = sessions.find(
    (s: { workspace: string }) => s.workspace === workspace,
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
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("说明历史项目");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await page
    .getByRole("group", { name: workspace, exact: true })
    .getByRole("button", { name: "新建对话", exact: true })
    .click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "说明历史项目" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(1);
  await page.getByLabel("任务描述").fill("继续说明");
  await page.getByRole("button", { name: "开始执行" }).click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(2);
  await page
    .getByRole("group", { name: workspace, exact: true })
    .getByRole("button", { name: "新对话" })
    .click();

  await expect(page.getByText("任务完成，已检查工具结果。")).toHaveCount(0);
});

test("reload service requires confirmation and reconnects after a replacement starts", async ({
  page,
}) => {
  let reloadRequested = 0;
  let replacementStarted = false;
  let replacementBootstrapRequests = 0;

  await page.route("**/api/bootstrap", async (route) => {
    if (!replacementStarted) {
      await route.continue();

      return;
    }

    const response = await route.fetch();
    const body = await response.json();

    replacementBootstrapRequests++;
    if (replacementBootstrapRequests === 1) {
      body.token = "replacement-session-token";
    }

    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/server/reload", async (route) => {
    reloadRequested++;
    replacementStarted = true;
    expect(route.request().postDataJSON()).toEqual({ confirm: true });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "重载服务", exact: true }).click();

  await expect(
    page.getByRole("dialog", { name: "重载服务确认" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂不重载" }).click();
  expect(reloadRequested).toBe(0);

  await page.getByRole("button", { name: "重载服务", exact: true }).click();
  await page.getByRole("button", { name: "确认重载服务" }).click();

  await expect.poll(() => reloadRequested).toBe(1);
  await expect
    .poll(() => replacementBootstrapRequests)
    .toBeGreaterThanOrEqual(2);
  await expect(
    page.getByRole("button", { name: "重载服务", exact: true }),
  ).toBeVisible();
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
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("准备上下文压缩");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("已准备长历史。", { exact: true })).toBeVisible();
  const project = page.getByRole("group", { name: workspace, exact: true });
  await project.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(project.getByRole("button", { name: "新对话" })).toBeVisible();
  await project.getByRole("button", { name: "准备上下文压缩" }).click();
  await page.getByLabel("任务描述").fill("继续，保持原任务要求");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(
    page.getByText("正在整理上下文，已保存的历史对话不会删除。"),
  ).toBeVisible();
  await project.getByRole("button", { name: "新对话" }).click();
  // 快照已在本机完成时不会稳定地经过短暂加载态；另一个延迟快照用例覆盖该反馈。
  await expect(page.getByLabel("任务描述")).toBeVisible();
  await project.getByRole("button", { name: "准备上下文压缩" }).click();
  await expect(page.getByText(/上下文已整理：/)).toBeHidden();
  await expect(
    page.getByText("任务完成，已检查工具结果。", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expandTaskProcess(page);
  await expect(page.getByText(/上下文已整理：/)).toBeVisible();
  await page.reload();
  await project.getByRole("button", { name: "准备上下文压缩" }).click();
  await expect(
    page.getByRole("main").getByText("准备上下文压缩", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("已准备长历史。", { exact: true })).toBeVisible();
  await expect(page.getByText(/上下文已整理：/)).toBeHidden();
  await expandTaskProcess(page);
  await expect(page.getByText(/上下文已整理：/)).toBeVisible();
});

test("shows discovered token budget and persisted actual usage", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-e2e-")),
  );
  await page.goto("/");
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("检查 token 用量");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(
    page.getByText("上下文预算：token 模式", { exact: true }),
  ).toBeHidden();
  await expandTaskProcess(page);
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
  await page.getByRole("button", { name: "检查 token 用量" }).click();
  await expandTaskProcess(page);
  await expect(
    page.getByText("模型用量（服务实报）：输入 100 / 输出 20 token", {
      exact: true,
    }),
  ).toBeVisible();
});

test("creates another conversation from its project and preserves separate history", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-project-")),
  );
  await page.goto("/");
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("项目对话一任务");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();

  const project = page.getByRole("group", { name: workspace, exact: true });
  await project.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新建会话" })).toHaveCount(0);
  await expect(
    project.getByRole("button", { name: "项目对话一任务" }),
  ).toBeVisible();
  await expect(project.getByRole("button", { name: "新对话" })).toBeVisible();
  await page.getByLabel("任务描述").fill("项目对话二任务");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await expect(
    project.getByRole("button", { name: "项目对话二任务" }),
  ).toBeVisible();
  await page.reload();
  let delayedSnapshot = false;
  let selectedSnapshotRequests = 0;
  await page.route("**/api/sessions/*", async (route) => {
    const request = route.request();
    if (request.method() === "GET" && !request.url().endsWith("/events")) {
      selectedSnapshotRequests++;
      if (!delayedSnapshot) {
        delayedSnapshot = true;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    await route.continue();
  });
  await project.getByRole("button", { name: "项目对话一任务" }).click();
  await expect(
    page.getByRole("heading", { name: "正在打开对话…" }),
  ).toBeVisible();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  expect(selectedSnapshotRequests).toBe(1);
  await page.unroute("**/api/sessions/*");
  await project.getByRole("button", { name: "项目对话二任务" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
  await page.screenshot({
    path: "test-results/project-conversations.png",
    fullPage: true,
  });
});

test("folds a project's older conversations and keeps full titles available", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-project-folding-")),
  );
  const projectName = path.basename(workspace);
  const longTitle =
    "这是一个用于检查侧边栏单行截断和完整悬浮标题的很长对话标题";

  await page.goto("/");
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill(longTitle);
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(
    page.getByRole("button", { name: longTitle, exact: true }),
  ).toBeVisible();

  const project = page.getByRole("group", { name: workspace, exact: true });
  for (let count = 1; count <= 5; count++) {
    await project
      .getByRole("button", { name: "新建对话", exact: true })
      .click();
  }

  // updatedAt 在同一毫秒内相同的记录不承诺二级排序，因此只验证确有一条较早记录被折叠。
  await project
    .getByRole("button", { name: "展开其他 1 个对话", exact: true })
    .click();
  const longConversation = project.getByRole("button", {
    name: longTitle,
    exact: true,
  });
  await expect(longConversation).toBeVisible();
  await expect(longConversation).toHaveAttribute("title", longTitle);
  await expect(longConversation.locator("strong")).toHaveCSS(
    "white-space",
    "nowrap",
  );
  await expect(longConversation.locator("strong")).toHaveCSS(
    "text-overflow",
    "ellipsis",
  );

  await project
    .getByRole("button", { name: `折叠 ${projectName} 的对话`, exact: true })
    .click();
  await expect(longConversation).toBeHidden();
  await expect(
    project.getByRole("button", {
      name: `展开 ${projectName} 的对话`,
      exact: true,
    }),
  ).toBeVisible();
  await project
    .getByRole("button", { name: `展开 ${projectName} 的对话`, exact: true })
    .click();
  await expect(longConversation).toBeVisible();
});

test("shows unified file-edit progress and retains it after reload", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-batch-")),
  );
  try {
    for (const name of ["a.txt", "b.txt"]) {
      await writeFile(path.join(workspace, name), "old");
    }

    await page.goto("/");
    await createInitialConversation(page, workspace);
    await page.getByLabel("任务描述").fill("批量编辑文件");
    await page.getByRole("button", { name: "开始执行" }).click();
    await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
    await expect(page.getByText("文件编辑进度", { exact: true })).toBeHidden();
    await expandTaskProcess(page);
    await expect(page.getByText("文件编辑进度", { exact: true })).toBeVisible();
    await expect(page.getByText("：已写入", { exact: false })).toHaveCount(2);
    await expect(page.getByText("修改预览", { exact: false })).toHaveCount(2);
    for (const name of ["a.txt", "b.txt"]) {
      expect(await readFile(path.join(workspace, name), "utf8")).toBe("new");
    }

    await page.reload();
    await page
      .getByRole("button", { name: "批量编辑文件", exact: true })
      .click();
    await expandTaskProcess(page);
    await expect(page.getByText("：已写入", { exact: false })).toHaveCount(2);
    await expect(
      page.getByText("写入中或结果未知", { exact: false }),
    ).toHaveCount(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("virtualizes timeline entries outside the visible scroll window", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-virtual-timeline-")),
  );

  try {
    await page.goto("/");
    await createInitialConversation(page, workspace);

    for (let index = 1; index <= 12; index += 1) {
      await page.getByLabel("任务描述").fill(`虚拟时间线条目 ${index}`);
      await page.getByRole("button", { name: "开始执行" }).click();
      await expect(
        page.getByRole("button", { name: "停止任务" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "停止任务" })).toHaveCount(
        0,
      );
    }

    const scrollArea = page.locator('[class*="scrollArea"]');
    await scrollArea.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      page.locator('[data-timeline-placeholder="before"]'),
    ).toHaveCount(1);
    const timelineItems = page.locator("[data-timeline-key]");
    expect(await timelineItems.count()).toBeLessThan(24);

    await scrollArea.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(
      page.locator('[data-timeline-placeholder="after"]'),
    ).toHaveCount(1);
    await expect(
      timelineItems.getByText("虚拟时间线条目 1", { exact: true }),
    ).toBeVisible();
    await expect(
      timelineItems.getByText("虚拟时间线条目 12", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("shows every failed file while retaining successful batch edits", async ({
  page,
}) => {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "codeatelier-batch-failure-")),
  );
  try {
    for (const name of ["a.txt", "b.txt"]) {
      await writeFile(path.join(workspace, name), "old");
    }

    await page.goto("/");
    await createInitialConversation(page, workspace);
    await page.getByLabel("任务描述").fill("批量编辑部分失败");
    await page.getByRole("button", { name: "开始执行" }).click();
    await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
    await expandTaskProcess(page);
    await expect(
      page.getByText("a.txt：已写入", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("b.txt：未写入；错误：", { exact: false }),
    ).toBeVisible();
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new");
    expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("old");

    await page.reload();
    await page
      .getByRole("button", { name: "批量编辑部分失败", exact: true })
      .click();
    await expandTaskProcess(page);
    await expect(
      page.getByText("a.txt：已写入", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("b.txt：未写入；错误：", { exact: false }),
    ).toBeVisible();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
