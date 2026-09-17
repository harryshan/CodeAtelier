/**
 * pnpm test:e2e 使用的浏览器测试配置，运行 tests/e2e 中的用例。
 * 后端由本地测试夹具启动，模型使用固定模拟响应。
 *
 * 1. 设置单 worker、串行执行和超时，避免用例争用测试服务状态。
 * 2. use 指定访问地址、窗口大小，并在失败时保留 trace。
 * 3. webServer 覆盖所有 CodeAtelier 连接变量、启动夹具且不复用已有服务；projects 选择 Chromium。
 *
 * 测试端口与日常服务分开，防止误操作用户会话；运行前需要安装测试浏览器。
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4143",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx tests/fixtures/server.ts",
    env: {
      CODEATELIER_BASE_URL: "http://127.0.0.1:9999/v1",
      CODEATELIER_MODEL: "test-model",
      CODEATELIER_API_KEY: "",
      CODEATELIER_AUXILIARY_MODEL: "",
      CODEATELIER_AUXILIARY_REASONING_EFFORT: "",
    },
    url: "http://127.0.0.1:4143",
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
