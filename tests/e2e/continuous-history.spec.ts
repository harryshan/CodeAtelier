/**
 * 验证 App 的连续历史浏览，使用分页 HTTP/SSE 合成夹具，不访问模型或个人历史。
 * 1. installHistory 提供三页消息及可控旧页故障，保留真实 EventSource 重连路径。
 * 2. 向上滚动自动前插，检查阅读锚点、首尾可达、有限 DOM 和实时消息不抢滚动；到达开头不留提示或空状态栏。
 * 3. 失败后保留当前记录，显式重试恢复；在途请求切换会话不混入旧结果，短页自动补足。
 */
import { expect, test, type Page } from "@playwright/test";
import type { Event, Snapshot } from "../../src/shared/types.js";

async function installHistory(page: Page, count = 300, pageSize = 100) {
  const createdAt = "2026-10-13T00:00:00.000Z";
  const session = {
    id: "continuous",
    workspace: "/history",
    title: "连续历史",
    titleState: "completed" as const,
    createdAt,
    updatedAt: createdAt,
  };
  const other = { ...session, id: "other", title: "另一段对话" };
  const events: Event[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    sessionId: session.id,
    taskId: "t",
    type: "user",
    data: { text: `历史消息 ${index + 1}` },
    createdAt,
  }));
  const state = {
    before: [] as number[],
    after: [] as number[],
    fail: false,
    live: false,
    hold: undefined as Promise<void> | undefined,
  };
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session, other] }),
  );
  await page.route(
    /\/api\/sessions\/(continuous|other)(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const before = Number(url.searchParams.get("before") ?? 0);
      const after = Number(url.searchParams.get("after") ?? 0);
      if (before) {
        state.before.push(before);
        expect(url.searchParams.get("highWater")).toBe(String(count));
        await state.hold;
        if (state.fail) {
          await route.fulfill({
            status: 503,
            json: { error: "历史读取暂时失败" },
          });

          return;
        }
      } else {
        state.after.push(after);
      }

      const isOther = url.pathname.endsWith("/other");
      const highWater = state.live ? count + 1 : count;
      const selected = isOther
        ? []
        : before
          ? events.filter((event) => event.id < before).slice(-pageSize)
          : after
            ? state.live && after < count + 1
              ? [
                  {
                    ...events[0],
                    id: count + 1,
                    data: { text: "最新追加消息" },
                  },
                ]
              : []
            : events.slice(-pageSize);
      const body: Snapshot = {
        session: isOther ? other : session,
        tasks: [],
        approvals: [],
        events: selected,
        history: {
          highWater: before ? count : highWater,
          cursor: before ? count : highWater,
          hasOlder: !isOther && !after && selected[0]?.id > 1,
          hasNewer: false,
        },
      };
      await route.fulfill({ json: body });
    },
  );
  await page.route(/\/api\/sessions\/(continuous|other)\/events$/, (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: session.title, exact: true }).click();
  await expect(
    page.getByText(`历史消息 ${count}`, { exact: true }),
  ).toBeVisible();

  return state;
}

test("fills a short viewport automatically until the beginning is reached", async ({
  page,
}) => {
  const state = await installHistory(page, 3, 1);
  for (const id of [1, 2, 3]) {
    await expect(
      page.getByText(`历史消息 ${id}`, { exact: true }),
    ).toBeVisible();
  }

  await expect(page.getByText("已到对话开头", { exact: true })).toHaveCount(0);
  await expect(
    page.locator('[class*="scrollArea"]').getByRole("status"),
  ).toHaveCount(0);
  expect(state.before).toEqual([3, 2]);
});

test("ignores an old page that finishes after switching conversations", async ({
  page,
}) => {
  const state = await installHistory(page);
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.locator('[class*="scrollArea"]').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => state.before).toEqual([201]);
  await expect(
    page.getByText("正在加载更早记录…", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "另一段对话", exact: true }).click();
  release();
  await expect(
    page.getByText("从一个具体的任务开始", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^历史消息 /)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试加载历史" })).toHaveCount(
    0,
  );
});

const areaSelector = '[class*="scrollArea"]';

test("scrolls continuously through all pages while keeping the reading position", async ({
  page,
}) => {
  const state = await installHistory(page);
  const area = page.locator(areaSelector);
  await expect(
    page.getByRole("button", { name: /查看更早|返回最新记录/ }),
  ).toHaveCount(0);
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => state.before).toEqual([201]);
  await expect(page.getByText("历史消息 201", { exact: true })).toBeVisible();
  // 前插后停留在原来的消息，而不是跳到最早或最新一条。
  const position = await area.evaluate((element) => element.scrollTop);
  expect(position).toBeGreaterThan(0);
  state.live = true;
  await expect.poll(() => state.after.includes(301)).toBe(true);
  await expect(page.getByText("历史消息 201", { exact: true })).toBeVisible();
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => state.before).toEqual([201, 101]);
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByText("历史消息 1", { exact: true })).toBeVisible();
  expect(await page.locator("[data-timeline-key]").count()).toBeLessThan(30);
  await area.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText("最新追加消息", { exact: true })).toBeVisible();
  expect(state.before).toEqual([201, 101]);
});

test("keeps loaded messages on failure and retries without a pagination button", async ({
  page,
}) => {
  const state = await installHistory(page);
  state.fail = true;
  const area = page.locator(areaSelector);
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  const retry = page.getByRole("button", { name: "重试加载历史" });
  await expect(retry).toBeVisible();
  await expect(page.getByText("历史消息 201", { exact: true })).toBeVisible();
  const requests = state.before.length;
  await page.getByLabel("任务描述").fill("加载失败仍可编辑");
  expect(state.before).toHaveLength(requests);
  state.fail = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect.poll(() => state.before.length).toBe(requests + 1);
  await page.getByRole("button", { name: "另一段对话", exact: true }).click();
  await expect(
    page.getByText("从一个具体的任务开始", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("历史消息 201", { exact: true })).toHaveCount(0);
});
