/**
 * 验证历史时间线的像素级滚动稳定性，弥补仅检查消息可见的分页回归。
 * 1. installTimeline 用合成的不等高消息、可控追加和分页响应挂载真实 App。
 * 2. sampleScroll 在用户滚动后逐帧观察原可见条目，检查虚拟测量不产生二次位移。
 * 3. 用例覆盖虚拟窗口向上/向下移动、真实滚轮退出跟随、回到底部恢复跟随，以及异步前插期间继续阅读；不访问个人数据或模型。
 */
import { expect, test, type Page } from "@playwright/test";
import type { Event, Snapshot } from "../../src/shared/types.js";

async function installTimeline(page: Page, paged = false) {
  const createdAt = "2026-10-13T00:00:00.000Z";
  const session = {
    id: "scroll-stability",
    workspace: "/scroll-test",
    title: "滚动稳定性",
    titleState: "completed" as const,
    createdAt,
    updatedAt: createdAt,
  };
  const events: Event[] = Array.from({ length: 80 }, (_, index) => ({
    id: index + 1,
    sessionId: session.id,
    taskId: "t",
    type: "user",
    createdAt,
    data: {
      text:
        `消息 ${index + 1}\n\n` +
        Array.from(
          { length: index % 4 === 0 ? 12 : 1 },
          (_, line) => `段落 ${line + 1}：用于测试高度不同的历史消息。`,
        ).join("\n\n"),
    },
  }));
  const state = {
    append: false,
    after: 0,
    older: 0,
    hold: undefined as Promise<void> | undefined,
  };
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session] }),
  );
  await page.route(
    /\/api\/sessions\/scroll-stability(?:\?.*)?$/,
    async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const before = Number(params.get("before"));
      const after = Number(params.get("after"));
      if (before) {
        state.older++;
        await state.hold;
      } else {
        state.after = after;
      }

      const body: Snapshot = {
        session,
        tasks: [],
        approvals: [],
        events: before
          ? events.slice(0, 40)
          : after
            ? state.append && after < 81
              ? [{ ...events[79], id: 81, data: { text: "新到达的消息" } }]
              : []
            : paged
              ? events.slice(40)
              : events,
        history: {
          cursor: state.append && !before ? 81 : 80,
          highWater: 80,
          hasOlder: paged && !after && !before,
          hasNewer: false,
        },
      };
      await route.fulfill({ json: body });
    },
  );
  await page.route("**/api/sessions/scroll-stability/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: refresh\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: session.title, exact: true }).click();
  await expect(page.getByText("消息 80", { exact: true })).toBeVisible();

  return state;
}

async function sampleScroll(page: Page, distance: number) {
  return page
    .locator('[class*="scrollArea"]')
    .evaluate(async (container, delta) => {
      container.scrollTop += delta;
      const top = container.getBoundingClientRect().top;
      const anchor = Array.from(
        container.querySelectorAll<HTMLElement>("[data-timeline-key]"),
      ).find((item) => {
        const bounds = item.getBoundingClientRect();

        return (
          bounds.bottom > top + 1 && bounds.top < top + container.clientHeight
        );
      });
      if (!anchor) {
        throw new Error("测试滚动步长内必须保留一个原可见条目");
      }

      const key = anchor.dataset.timelineKey!;
      const baseline = anchor.getBoundingClientRect().top;
      const shifts: number[] = [];
      for (let frame = 0; frame < 12; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const current = Array.from(
          container.querySelectorAll<HTMLElement>("[data-timeline-key]"),
        ).find((item) => item.dataset.timelineKey === key);
        shifts.push(
          current
            ? current.getBoundingClientRect().top - baseline
            : Number.MAX_SAFE_INTEGER,
        );
      }

      return { key, shifts };
    }, distance);
}

test("keeps variable-height messages stationary after each scroll step", async ({
  page,
}) => {
  await installTimeline(page);
  for (const direction of [-1, 1]) {
    for (let step = 0; step < 18; step++) {
      const result = await sampleScroll(page, direction * 120);
      expect(
        Math.max(...result.shifts.map(Math.abs)),
        JSON.stringify(result),
      ).toBeLessThanOrEqual(2);
    }
  }
});

test("does not pull a small upward scroll back to the latest message", async ({
  page,
}) => {
  const state = await installTimeline(page);
  const area = page.locator('[class*="scrollArea"]');
  const bounds = (await area.boundingBox())!;
  const initialTop = await area.evaluate((container) => container.scrollTop);
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.wheel(0, -40);
  await expect
    .poll(() => area.evaluate((container) => container.scrollTop))
    .toBeLessThan(initialTop - 20);
  await sampleScroll(page, 0);
  const message = page.getByText("消息 80", { exact: true });
  const before = (await message.boundingBox())!.y;
  state.append = true;
  await expect.poll(() => state.after).toBe(81);
  expect(
    Math.abs((await message.boundingBox())!.y - before),
  ).toBeLessThanOrEqual(2);
});

test("resumes following only after returning to the bottom", async ({
  page,
}) => {
  const state = await installTimeline(page);
  await sampleScroll(page, -120);
  await page.locator('[class*="scrollArea"]').evaluate((container) => {
    container.scrollTop = container.scrollHeight;
  });
  await sampleScroll(page, 0);
  state.append = true;
  await expect(page.getByText("新到达的消息", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('[class*="scrollArea"]')
        .evaluate(
          (container) =>
            container.scrollHeight -
            container.scrollTop -
            container.clientHeight,
        ),
    )
    .toBeLessThanOrEqual(1);
});

for (const movement of [0, 170]) {
  test(`keeps an exact reading anchor while prepending after moving ${movement}px`, async ({
    page,
  }) => {
    const state = await installTimeline(page, true);
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.locator('[class*="scrollArea"]').evaluate((container) => {
      container.scrollTop = 0;
    });
    await expect.poll(() => state.older).toBe(1);
    const message = page.getByText("消息 41", { exact: true });
    await expect(message).toBeVisible();
    await sampleScroll(page, movement);
    const before = (await message.boundingBox())!.y;
    release();
    await expect(
      page.getByText("正在加载更早记录…", { exact: true }),
    ).toHaveCount(0);
    expect(
      Math.abs((await message.boundingBox())!.y - before),
    ).toBeLessThanOrEqual(2);
  });
}
