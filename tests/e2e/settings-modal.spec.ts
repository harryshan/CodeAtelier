/**
 * 设置模态框的浏览器回归，通过临时测试服务验证展示与交互，不调用真实模型。
 * 1. 桌面检查居中留白、主页面主题、原生模态隔离、键盘循环及关闭后的焦点恢复。
 * 2. 窄屏检查边界、独立滚动和保存栏，验证分类草稿、已移除并发上限控件与 Escape 放弃确认。
 * 仅修改浏览器内草稿，不保存设置、不重启服务；截图不包含真实凭据。
 */
import { expect, test } from "@playwright/test";

test("settings modal shares the main theme and isolates background interaction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "模型与设置" });
  const background = page.getByLabel("项目目录");
  const backgroundStyle = await background.evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor,
    font: getComputedStyle(node).fontFamily,
  }));
  await trigger.click();
  const modal = page.getByRole("dialog", { name: "CodeAtelier 设置" });
  const close = modal.getByRole("button", { name: "关闭设置", exact: true });
  const save = modal.getByRole("button", { name: "保存更改", exact: true });
  const model = modal.getByLabel("主模型名称", { exact: true });
  await expect(model).toBeVisible();

  const bounds = (await modal.boundingBox())!;
  expect(bounds.x).toBeGreaterThan(20);
  expect(bounds.y).toBeGreaterThan(20);
  expect(bounds.width).toBeLessThan(1440 - 40);
  expect(bounds.height).toBeLessThan(1000 - 40);
  expect(await modal.evaluate((node) => node.matches(":modal"))).toBe(true);
  expect(
    await model.evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      font: getComputedStyle(node).fontFamily,
    })),
  ).toEqual(backgroundStyle);

  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(save).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await background.evaluate((node: HTMLInputElement) => node.focus());
  await expect(close).toBeFocused();
  await page.mouse.click(4, 4);
  await expect(modal).toBeVisible();
  await close.focus();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(background).toBeEnabled();
});

test("settings modal fits narrow screens and protects unsaved drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "打开导航菜单" }).click();
  await page.getByRole("button", { name: "模型与设置" }).click();
  const modal = page.getByRole("dialog", { name: "CodeAtelier 设置" });
  const model = modal.getByLabel("主模型名称", { exact: true });
  await expect(model).toBeVisible();
  await model.fill("unsaved-modal-model");
  await modal
    .getByRole("button", { name: "任务与上下文", exact: true })
    .click();
  await expect(modal.getByLabel("任务最大轮次", { exact: true })).toBeVisible();
  await expect(
    modal.getByLabel("并行任务上限（立即生效）", { exact: true }),
  ).toHaveCount(0);
  await modal.getByRole("button", { name: "模型连接", exact: true }).click();
  await expect(model).toHaveValue("unsaved-modal-model");

  const bounds = (await modal.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(740);
  expect(
    await modal.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const save = modal.getByRole("button", { name: "保存更改", exact: true });
  await expect(save).toBeInViewport();
  await model.evaluate((node) => {
    let scroll = node.parentElement;
    while (scroll && getComputedStyle(scroll).overflowY !== "auto") {
      scroll = scroll.parentElement;
    }

    if (scroll) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  });
  await expect(save).toBeInViewport();
  await page.screenshot({ path: "test-results/settings-modal-mobile.png" });

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await expect(model).toHaveValue("unsaved-modal-model");
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});
