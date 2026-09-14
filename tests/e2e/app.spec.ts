/**
 * 用 Chromium 操作真实页面，检查用户完成会话任务时看到的结果。
 * Playwright 启动本地测试服务器和临时工作区，模型响应由 tests/fixtures/server.ts 模拟。
 *
 * 1. 创建会话、写文件、查看 diff、刷新历史，再检查审批、取消和设置保存。
 * 2. 检查重试文本分开显示、凭据失效后重新连接，以及会话切换后的数据隔离。
 * 3. 检查受确认的重载服务入口会等待替代服务、完整刷新页面，以及关闭服务成功和请求失败时的不同提示。
 * 4. 检查压缩通知、原始历史及模型用量在刷新后仍能显示。
 * 5. 验证多文件编辑的状态、diff 和刷新后的历史；通过页面内项目目录连接首个项目，再从项目标题右侧加号新建对话并检查历史隔离、折叠与最近记录限制。
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
  await expect(page.getByRole("button", { name: "修改文件" })).toBeVisible();
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
  expect(errors).toEqual([]);
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

test("settings validates and saves without exposing key", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "模型与设置" }).click();
  await expect(page.getByLabel("思考等级")).toHaveValue("high");
  await page.getByLabel("思考等级").selectOption("medium");
  await page.getByLabel("辅助模型（低成本，可选）").fill("test-small");
  await page.getByLabel("辅助模型推理强度").selectOption("low");
  await page.getByLabel("API key", { exact: true }).fill("ui-test-secret");
  await page.getByRole("button", { name: "保存设置" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  const response = await page.request.get("/api/settings");

  const saved = await response.text();
  expect(saved).not.toContain("ui-test-secret");
  expect(JSON.parse(saved).settings.reasoningEffort).toBe("medium");
  expect(JSON.parse(saved).settings.auxiliaryModel).toBe("test-small");
  await page.reload();
  await page.getByRole("button", { name: "模型与设置" }).click();
  await expect(page.getByLabel("思考等级")).toHaveValue("medium");
  await page.screenshot({ path: "test-results/settings.png", fullPage: true });
  await expect(page.getByLabel("辅助模型（低成本，可选）")).toHaveValue(
    "test-small",
  );
  await page.getByLabel("辅助模型（低成本，可选）").fill("");
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
  await page.getByLabel("任务描述").fill("继续，保持原任务要求");
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.getByText(/上下文已整理：/)).toBeVisible();
  await expect(
    page.getByText("任务完成，已检查工具结果。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "准备上下文压缩" }).click();
  await expect(
    page.getByRole("main").getByText("准备上下文压缩", { exact: true }),
  ).toBeVisible();
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
  await createInitialConversation(page, workspace);
  await page.getByLabel("任务描述").fill("检查 token 用量");
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
  await page.getByRole("button", { name: "检查 token 用量" }).click();
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
  await project.getByRole("button", { name: "项目对话一任务" }).click();
  await expect(page.getByText("任务完成，已检查工具结果。")).toBeVisible();
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

test("shows multi-file edit progress and retains it after reload", async ({
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
    await expect(page.getByText("批量编辑进度", { exact: true })).toBeVisible();
    await expect(page.getByText("：已写入", { exact: false })).toHaveCount(2);
    await expect(page.getByText("修改预览", { exact: false })).toHaveCount(2);
    for (const name of ["a.txt", "b.txt"]) {
      expect(await readFile(path.join(workspace, name), "utf8")).toBe("new");
    }

    await page.reload();
    await page
      .getByRole("button", { name: "批量编辑文件", exact: true })
      .click();
    await expect(page.getByText("：已写入", { exact: false })).toHaveCount(2);
    await expect(
      page.getByText("写入中或结果未知", { exact: false }),
    ).toHaveCount(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
