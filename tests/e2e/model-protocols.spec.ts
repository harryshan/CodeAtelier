/**
 * 用浏览器验证多协议设置的编辑控件与能力提示，不连接真实模型。
 * 1. GET settings 只覆盖公开编辑视图，保留测试服务的鉴权与其它状态。
 * 2. 打开设置检查主/辅助独立协议、地址以及不适用的思考参数禁用。
 * 3. Responses 仍能编辑思考等级；新协议的搜索限制明确可见。
 */
import { expect, test } from "@playwright/test";

for (const protocol of ["chat-completions", "messages", "responses"]) {
  test(`shows ${protocol} capabilities without offering unsupported reasoning`, async ({
    page,
  }) => {
    await page.route("**/api/settings", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          editor: {
            ...body.editor,
            configuration: {
              ...body.editor.configuration,
              models: {
                main: { ...body.editor.configuration.models.main, protocol },
                auxiliary: {
                  ...body.editor.configuration.models.auxiliary,
                  protocol: "messages",
                  inheritConnection: false,
                  inheritKey: false,
                  baseUrl: "https://auxiliary.example.test/v1",
                  model: "aux-fixture",
                },
              },
            },
          },
        },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "模型与设置" }).click();
    await expect(page.getByLabel("主模型协议", { exact: true })).toHaveValue(
      protocol,
    );
    await expect(page.getByLabel("辅助模型 API 地址")).toHaveValue(
      "https://auxiliary.example.test/v1",
    );
    await expect(
      page
        .getByText("当前协议仅支持文字与本地工具，不发送思考参数或内置搜索。")
        .first(),
    ).toBeVisible();
    await expect(page.getByLabel("辅助模型思考等级")).toBeDisabled();
    if (protocol === "responses") {
      await expect(
        page.getByLabel("主模型思考等级", { exact: true }),
      ).toBeEnabled();
    } else {
      await expect(
        page.getByLabel("主模型思考等级", { exact: true }),
      ).toBeDisabled();
    }
  });
}
