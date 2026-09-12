/**
 * 文件作用：配置使用本机模拟服务的浏览器端到端测试。
 * 代码结构：按测试目录和串行执行、浏览器参数、测试服务器启动及 Chromium 项目组织配置。
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
    command: "pnpm exec tsx tests/fixtures/server.ts",
    url: "http://127.0.0.1:4143",
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
