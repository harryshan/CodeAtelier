/**
 * 回归测试默认测试进程的连接隔离，防止运行器或 Vite 配置重新继承开发机 dotenv、模型标识或密钥。
 * 该文件由 Vitest 在其余普通测试前后均可独立执行，只读取 test-runner.ts 注入的进程环境，不创建 Config 或网络请求。
 *
 * 1. 固定连接断言验证测试只使用本机不可路由的预设端点和测试模型。
 * 2. 密钥与可选辅助模型断言验证没有从父进程或 dotenv 继承生产凭据和模型配置。
 *
 * 此测试只检查启动边界；模型行为由各集成测试注入的模拟 ModelProvider 或本机 HTTP/SSE 回复验证。
 */

import { expect, it } from "vitest";

it("runs with only the preset offline model connection and no API key", () => {
  expect({
    baseUrl: process.env.CODEATELIER_BASE_URL,
    model: process.env.CODEATELIER_MODEL,
    apiKey: process.env.CODEATELIER_API_KEY,
    auxiliaryModel: process.env.CODEATELIER_AUXILIARY_MODEL,
    auxiliaryReasoningEffort:
      process.env.CODEATELIER_AUXILIARY_REASONING_EFFORT,
    passwordEnabled: process.env.CODEATELIER_WEB_PASSWORD_ENABLED,
    password: process.env.CODEATELIER_WEB_PASSWORD,
  }).toEqual({
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "test-model",
    apiKey: "",
    auxiliaryModel: "",
    auxiliaryReasoningEffort: "",
    passwordEnabled: "",
    password: "",
  });
});
