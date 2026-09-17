/**
 * 用 Chromium 检查前端访问密码门禁的可见交互。
 * Playwright 仍使用默认关闭的本机测试服务；本文件仅拦截门禁 API，模拟启用状态和正确/错误密码，成功后由真实 bootstrap 加载主页面。
 *
 * 1. 访问状态宣告启用时，确认主页面尚未渲染且密码输入可见。
 * 2. 错误密码返回 401，页面保留门禁并显示服务错误。
 * 3. 正确密码返回成功，AccessGate 才挂载 App，后续 bootstrap 走真实测试服务。
 *
 * 路由模拟只隔离密码门禁状态，不伪造会话、模型或持久化接口；测试不包含真实密码。
 */

import { expect, test } from "@playwright/test";

test("requires a correct password before rendering the CodeAtelier page", async ({
  page,
}) => {
  await page.route("**/api/access/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, authenticated: false }),
    });
  });
  await page.route("**/api/access/login", async (route) => {
    const password = JSON.parse(route.request().postData() || "{}").password;

    await route.fulfill({
      status: password === "correct-password" ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        password === "correct-password"
          ? { ok: true }
          : { error: "密码不正确。" },
      ),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "访问验证" })).toBeVisible();
  await expect(page.getByText("让想法，")).toBeHidden();
  await page.getByLabel("访问密码").fill("incorrect-password");
  await page.getByRole("button", { name: "进入 CodeAtelier" }).click();
  await expect(page.getByText("密码不正确。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "访问验证" })).toBeVisible();

  await page.getByLabel("访问密码").fill("correct-password");
  await page.getByRole("button", { name: "进入 CodeAtelier" }).click();

  await expect(page.getByText("让想法，")).toBeVisible();
});
