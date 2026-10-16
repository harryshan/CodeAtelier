/**
 * 使用合成历史和受控正文接口验证 Timeline 的技术记录展示，不运行模型或工具。
 * 1. openRecords 安装仅属于测试会话的 HTTP/SSE 路由，保留真实页面、虚拟列表和安全文本渲染。
 * 2. 工具名称、结果摘要和未关联输出检查中文语义、原文保真、限高滚动与窄屏布局。
 * 3. 大正文检查按需加载、分段替换、错误重试、空片段、收起取消和刷新后的初始状态。
 * 所有正文都是不可信夹具；HTML 不得成为 DOM，缺失或未知结果不能被展示为成功。
 */
import { expect, test, type Page } from "@playwright/test";
import type { Event, Snapshot } from "../../src/shared/types.js";

const createdAt = "2026-10-16T00:00:00.000Z";
const session = {
  id: "timeline-records",
  workspace: "/timeline-records",
  title: "技术记录展示",
  titleState: "completed" as const,
  createdAt,
  updatedAt: createdAt,
};

function record(type: string, data: unknown, id = 1): Event {
  return { id, sessionId: session.id, taskId: "task", type, data, createdAt };
}

async function openRecords(page: Page, events: Event[]) {
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route(/\/api\/sessions\/timeline-records(?:\?.*)?$/, (route) => {
    const after = Number(
      new URL(route.request().url()).searchParams.get("after") ?? 0,
    );
    const snapshot: Snapshot = {
      session,
      tasks: [],
      approvals: [],
      events: events.filter((event) => event.id > after),
    };

    return route.fulfill({ json: snapshot });
  });
  await page.route("**/api/sessions/timeline-records/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await selectRecords(page);
}

async function selectRecords(page: Page) {
  if (await page.evaluate(() => matchMedia("(max-width: 650px)").matches)) {
    await page.getByRole("button", { name: "打开导航菜单" }).click();
  }

  await page.getByRole("button", { name: session.title, exact: true }).click();
}

test("labels tools in Chinese while retaining their identifiers and raw arguments", async ({
  page,
}) => {
  const tools = [
    ["mcp", "MCP 服务"],
    ["skill", "技能参考"],
    ["memory_apply", "项目记忆"],
    ["read_context_history", "读取归档上下文"],
  ];
  await openRecords(
    page,
    tools.map(([name], index) =>
      record(
        "tool_start",
        {
          name,
          callId: `call-${index}`,
          args: { request: { action: "list" } },
        },
        index + 1,
      ),
    ),
  );

  for (const [name, label] of tools) {
    const card = page
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: label }) });
    await expect(card.locator("summary")).toContainText(name);
    await card.locator("summary").click();
    await expect(card.locator("pre")).toHaveText(
      JSON.stringify({ request: { action: "list" } }, null, 2),
    );
  }
});

for (const [type, title] of [
  ["command_output", "未关联的命令输出"],
  ["capability_output", "未关联的宿主命令输出"],
  ["git_output", "未关联的 Git 输出（旧记录）"],
]) {
  test(`wraps ${type} without inventing a successful result`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const text =
      "<b>not markup</b>\n" + "long-output".repeat(100) + "\nline".repeat(100);
    await openRecords(page, [record(type, { callId: "missing-start", text })]);
    const card = page.getByRole("region", { name: title, exact: true });
    await expect(card).toContainText("执行状态未知");
    await expect(card.locator("pre")).toHaveText(text);
    await expect(card.locator("pre b")).toHaveCount(0);
    await expect(card.locator("pre")).toHaveCSS("overflow-y", "auto");
    await expect(card.locator("pre")).toHaveCSS("max-height", "300px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await selectRecords(page);
    await expect(card.locator("pre")).toHaveText(text);
  });
}

test("summarizes known results without hiding partial failures or changing raw JSON", async ({
  page,
}) => {
  const result = {
    files: [
      { path: "ok.ts", status: "written" },
      { path: "bad.ts", status: "failed", error: "<b>denied</b>" },
      { path: "pending.ts", status: "unknown" },
      { path: "later.ts", status: "not_attempted" },
    ],
  };
  await openRecords(page, [
    record("tool_result", {
      name: "read_file",
      result: {
        path: "sample.ts",
        totalLines: 12,
        returnedEndLine: 5,
        hasMore: true,
      },
    }),
    record("tool_result", { name: "edit_files", result }, 2),
    record("tool_result", { name: "mcp" }, 3),
  ]);
  await expect(
    page.locator("summary").filter({ hasText: "sample.ts" }),
  ).toContainText("共 12 行");
  const edit = page.locator("details").filter({
    has: page.locator("summary", { hasText: "新建或精确修改文件" }),
  });
  await expect(edit.locator("summary")).toContainText(
    "已写入 1 · 失败 1 · 未知 1 · 未执行 1",
  );
  await edit.locator("summary").click();
  await expect(edit.locator("pre")).toHaveText(JSON.stringify(result, null, 2));
  await expect(edit.locator("pre b")).toHaveCount(0);
  const missing = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "MCP 服务" }) });
  await expect(missing.locator("summary")).toContainText("结果未记录");
  await expect(missing.locator("summary")).not.toContainText("✓");
});

test("loads raw body pages on demand with retry, empty and collapsed states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: number[] = [];
  let fail = true;
  const first = '{"text":"<b>literal</b>\\n' + "x".repeat(16340);
  await page.route(
    "**/api/sessions/timeline-records/event-body/1?*",
    (route) => {
      const offset = Number(
        new URL(route.request().url()).searchParams.get("offset"),
      );
      requests.push(offset);
      if (fail) {
        return route.fulfill({
          status: 503,
          json: { error: "正文暂时不可读" },
        });
      }

      return route.fulfill({
        json: {
          text: offset === 0 ? first : "",
          next: offset === 0 ? 16384 : null,
        },
      });
    },
  );
  await openRecords(page, [
    {
      ...record("tool_result", { name: "read_file" }),
      bodyDeferred: true,
      bodyBytes: 40000,
    },
  ]);
  const card = page.getByRole("region", {
    name: "工具结果 · 读取文件",
    exact: true,
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText("40000 字节");
  expect(requests).toEqual([]);
  await card.getByRole("button", { name: "分段查看完整记录" }).click();
  await expect(card.getByRole("alert")).toContainText("正文暂时不可读");
  await expect(card.getByRole("button", { name: "下一段" })).toBeDisabled();
  fail = false;
  await card.getByRole("button", { name: "重试读取正文" }).click();
  await expect(card.locator("pre")).toHaveText(first);
  await expect(card.locator("pre b")).toHaveCount(0);
  await expect(card.locator("pre")).toHaveCSS("overflow-x", "auto");
  await expect(card.getByRole("button", { name: "上一段" })).toBeDisabled();
  await card.getByRole("button", { name: "下一段" }).click();
  await expect(card.getByRole("status")).toHaveText("此段没有内容。");
  await expect(card.locator("pre")).toHaveCount(0);
  await expect(card).toContainText("起始字符 16385");
  await expect(card.getByRole("button", { name: "下一段" })).toBeDisabled();
  await card.getByRole("button", { name: "上一段" }).click();
  await expect(card.locator("pre")).toHaveText(first);
  expect(requests).toEqual([0, 0, 16384, 0]);
  await card.getByRole("button", { name: "收起正文" }).click();
  await expect(card.locator("pre")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await selectRecords(page);
  await expect(
    card.getByRole("button", { name: "分段查看完整记录" }),
  ).toBeVisible();
  expect(requests).toHaveLength(4);
});

test("does not reveal a late body response after collapse", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(
    "**/api/sessions/timeline-records/event-body/1?*",
    async (route) => {
      requested = true;
      await hold;
      await route.fulfill({ json: { text: "late body", next: null } });
    },
  );
  await openRecords(page, [{ ...record("assistant", {}), bodyDeferred: true }]);
  const card = page.getByRole("region", { name: "助手消息", exact: true });
  await card.getByRole("button", { name: "分段查看完整记录" }).click();
  await expect.poll(() => requested).toBe(true);
  await expect(card.getByRole("status")).toHaveText("正在读取…");
  await card.getByRole("button", { name: "收起正文" }).click();
  release();
  await expect(
    card.getByRole("button", { name: "分段查看完整记录" }),
  ).toBeVisible();
  await expect(card.locator("pre")).toHaveCount(0);
});
