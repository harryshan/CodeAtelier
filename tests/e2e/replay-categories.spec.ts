/**
 * 数据库阅读器分类界面的浏览器回归，由 Playwright 在隔离测试服务上运行。
 * 1. 使用 viewerFixture 和超过一页的 Task 元数据模拟只读 API，不读取个人历史。
 * 2. 验证默认按轮次、模型/工具关联跳转、分类搜索及异常/未知状态，不把事件混进默认目录。
 * 3. 直接选择较早的 legacy Task，验证已有工具/事件仍可读且没有新增的加载按钮。
 * 请求均为合成读取；不启动模型、重放工具或执行 Evaluation。
 */
import { expect, test } from "@playwright/test";
import { viewerFixture } from "../fixtures/replay-viewer.js";

test("restores categorized database reading without manual loading controls", async ({
  page,
}) => {
  const session = {
    id: "categories",
    title: "分类阅读",
    workspace: "example",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    titleState: "manual",
  };
  const tasks = Array.from({ length: 105 }, (_, index) => ({
    id: `task-${index}`,
    sessionId: session.id,
    status: "completed",
    createdAt: "2026-01-01",
    subagentsEnabled: false,
  }));
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route("**/api/sessions/categories/tasks", (route) =>
    route.fulfill({ json: tasks }),
  );
  await page.route("**/api/sessions/categories/task-page", (route) =>
    route.fulfill({ json: { tasks: tasks.slice(-100), hasOlder: true } }),
  );
  await page.route("**/tasks/*/replay-directory?after=0", (route) =>
    route.fulfill({
      json: { captured: true, metadata: {}, entries: [], next: null },
    }),
  );
  await page.route("**/tasks/*/replay/export", (route) => {
    const data = viewerFixture();
    data.task.id = new URL(route.request().url()).pathname.split("/").at(-3)!;
    if (data.task.id === "task-0") {
      data.source = "legacy";
      delete data.capture;
    }

    return route.fulfill({ json: data });
  });
  await page.goto("/?view=replay&session=categories");

  const kind = page.getByLabel("记录类型", { exact: true });
  const status = page.getByLabel("记录状态", { exact: true });
  const navigation = page.getByRole("navigation", { name: "记录目录" });
  const detail = page.getByRole("article", { name: "记录详情" });
  await expect(kind).toHaveValue("rounds");
  await expect(page.getByLabel("任务概览")).toContainText("任务 task-104");
  await expect(
    navigation.getByRole("button", { name: /模型调用 #/ }),
  ).toHaveCount(3);
  await expect(navigation.getByRole("button", { name: /事件 #/ })).toHaveCount(
    0,
  );
  await expect(detail).toContainText("先读取文件，再运行检查。");
  await detail.getByRole("button", { name: /工具 #1 · read_file/ }).click();
  await expect(kind).toHaveValue("tool");
  await expect(detail).toContainText("first line");
  await detail.getByRole("button", { name: "返回所属模型调用" }).click();
  await expect(kind).toHaveValue("model");
  await expect(detail).toContainText("先读取文件，再运行检查。");

  await kind.selectOption("tool");
  await status.selectOption("error");
  await expect(navigation.getByRole("button", { name: /工具 #/ })).toHaveCount(
    1,
  );
  await expect(detail).toContainText("assertion failed");
  await status.selectOption("unknown");
  await expect(detail).toContainText("结果未知：没有保存返回值");
  await status.selectOption("");
  await page.getByLabel("搜索记录").fill("src/example.ts");
  await expect(navigation.getByRole("button", { name: /工具 #/ })).toHaveCount(
    1,
  );
  await expect(detail).toContainText("first line");
  await page.getByLabel("搜索记录").fill("");
  await kind.selectOption("event");
  await navigation.getByRole("button", { name: /事件 #2 · approval/ }).click();
  await expect(detail).toContainText("示例审批事件");

  await expect(
    page
      .getByLabel("选择 Task", { exact: true })
      .locator("option:not([disabled])"),
  ).toHaveCount(105);
  await page.getByLabel("选择 Task", { exact: true }).selectOption("task-0");
  await expect(page.getByLabel("任务概览")).toContainText("legacy");
  await expect(page.getByLabel("任务概览")).toContainText("没有捕获模型请求");
  await kind.selectOption("tool");
  await expect(detail).toContainText("first line");
  await kind.selectOption("event");
  await expect(detail).toContainText("请读取示例文件");
  await expect(
    page.getByRole("button", {
      name: /更早的 Task|最新 Task|目录首页|下一页请求|上一页输入|下一页输入|展开材料/,
    }),
  ).toHaveCount(0);
});
