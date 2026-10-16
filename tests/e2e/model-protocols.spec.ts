/**
 * 用浏览器验证多协议设置的只读展示与能力提示，不连接真实模型。
 * 1. bootstrap 只覆盖模型连接字段，保留测试服务的鉴权与其它状态。
 * 2. 打开设置检查主/辅助独立协议、地址以及不适用的思考参数禁用。
 * 3. Responses 仍能编辑思考等级；新协议的搜索限制明确可见。
 */
import { expect, test } from "@playwright/test";

for (const protocol of ["chat-completions", "messages", "responses"]) {
  test(`shows ${protocol} capabilities without offering unsupported reasoning`, async ({
    page,
  }) => {
    await page.route("**/api/bootstrap", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          settings: {
            ...body.settings,
            protocol,
            auxiliaryProtocol: "messages",
            auxiliaryBaseUrl: "https://auxiliary.example.test/v1",
            auxiliaryModel: "aux-fixture",
          },
        },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "模型与设置" }).click();
    await expect(page.getByLabel("连接配置")).toContainText(protocol);
    await expect(page.getByLabel("连接配置")).toContainText(
      "https://auxiliary.example.test/v1",
    );
    await expect(page.getByLabel("连接配置")).toContainText(
      "不提供内置网页搜索",
    );
    await expect(page.getByLabel("辅助模型推理强度")).toBeDisabled();
    if (protocol === "responses") {
      await expect(page.getByLabel("思考等级")).toBeEnabled();
    } else {
      await expect(page.getByLabel("思考等级")).toBeDisabled();
    }
  });
}
