/**
 * 自包含离线 HTML 的真实 Chromium 回归，不读取个人导出、不调用模型或工具。
 * 1. 在本测试独立输出目录生成页面，file:// 打开并监听网络请求和浏览器异常。
 * 2. 检查轮次/工具往返、惰性原始载荷、未知状态、搜索和事件视图。
 * 3. 本地导入覆盖分页、长文本、legacy、损坏文件保留旧视图，以及 HTML/script 载荷不执行。
 * 文件仅为合成夹具和测试产物，不通过 HTTP 服务传输其数据。
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { writeReplayHtml } from "../../src/replay-viewer/html.js";
import { viewerFixture } from "../fixtures/replay-viewer.js";

test("navigates model and tool details offline and safely imports local JSON", async ({
  page,
}, testInfo) => {
  const output = testInfo.outputPath("replay.html");
  await mkdir(path.dirname(output), { recursive: true });
  await writeReplayHtml(output, viewerFixture());
  const network: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) {
      network.push(request.url());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(output).href);
  const detail = page.getByRole("article", { name: "记录详情" });
  const nav = page.getByRole("navigation", { name: "记录目录" });
  await expect(detail).toContainText("先读取文件，再运行检查。");
  await expect(detail).toContainText("total_tokens");
  await expect(detail.locator("pre")).toHaveCount(1);
  await detail.getByText("输入上下文（1 项）", { exact: true }).click();
  await expect(detail).toContainText("请读取示例文件");
  await detail
    .getByRole("button", { name: "工具 #1 · read_file · 已记录", exact: true })
    .click();
  await expect(detail).toContainText("first line\nsecond line");
  await expect(detail).toContainText("src/example.ts");
  await detail.getByRole("button", { name: "返回所属模型调用" }).click();
  await expect(
    detail.getByRole("heading", { name: "模型调用 #1 · task", exact: true }),
  ).toBeVisible();

  await page.getByLabel("记录类型").selectOption("tool");
  await page.getByLabel("记录状态").selectOption("error");
  await expect(nav.locator("button[data-key]")).toHaveCount(1);
  await expect(detail).toContainText("assertion failed");
  await page.getByLabel("记录状态").selectOption("unknown");
  await expect(detail).toContainText("不会自动重放");
  await page.getByLabel("记录状态").selectOption("");
  await page.getByLabel("搜索记录").fill("src/example.ts");
  await expect(nav.locator("button[data-key]")).toHaveCount(1);
  await expect(detail).toContainText("first line");

  await page.getByLabel("搜索记录").fill("");
  await page.getByLabel("记录类型").selectOption("event");
  await nav.getByRole("button", { name: /事件 #2/ }).click();
  await expect(detail).toContainText("示例审批事件");

  const imported = viewerFixture();
  imported.source = "legacy";
  delete imported.capture;
  const hostile =
    '</script><script>globalThis.injected=true</script><img src="https://example.invalid/leak" onerror="globalThis.injected=true">';
  imported.session.title = hostile;
  imported.tools = Array.from({ length: 85 }, (_, index) => ({
    ...imported.tools[0],
    callId: `call-${index}`,
    nodeId: `node-${index}`,
    result: { text: `${"z".repeat(25000)}tail-marker` },
  }));
  await page.getByLabel("选择 Replay JSON").setInputFiles({
    name: "legacy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(
    page.getByRole("heading", { name: hostile, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "没有捕获模型请求。可查看已有工具和历史事件，不能重建缺失轮次。",
    ),
  ).toBeVisible();
  await expect(nav.locator("button[data-key]")).toHaveCount(40);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(nav).toContainText("2 / 3 页");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(nav.locator("button[data-key]")).toHaveCount(5);
  await nav.locator("button[data-key]").first().click();
  await expect(detail).not.toContainText("tail-marker");
  await detail
    .getByRole("button", { name: "继续显示（每次 20,000 字符）", exact: true })
    .click();
  await expect(detail).toContainText("tail-marker");

  await page.getByLabel("选择 Replay JSON").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(page.getByRole("alert")).toContainText("JSON 解析失败");
  await expect(detail).toContainText("tail-marker");
  await page.getByLabel("选择 Replay JSON").setInputFiles({
    name: "wrong.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"schemaVersion":2}'),
  });
  await expect(page.getByRole("alert")).toContainText("Replay Case v1");
  expect(await page.evaluate(() => "injected" in globalThis)).toBe(false);
  await expect(page.locator("img")).toHaveCount(0);
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});

test("opens an empty portable reader and accepts an exported task", async ({
  page,
}, testInfo) => {
  const output = testInfo.outputPath("empty.html");
  await mkdir(path.dirname(output), { recursive: true });
  await writeReplayHtml(output);
  await page.goto(pathToFileURL(output).href);
  await expect(
    page.getByRole("heading", { name: "CodeAtelier · 对话阅读器" }),
  ).toBeVisible();
  await page.getByLabel("选择 Replay JSON").setInputFiles({
    name: "case.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(viewerFixture())),
  });
  await expect(page.getByRole("article")).toContainText(
    "先读取文件，再运行检查。",
  );
});
