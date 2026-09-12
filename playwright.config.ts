/**
 * 文件作用：配置使用本机模拟服务的浏览器端到端测试。
 *
 * 使用场景与输入输出：
 * 供 pnpm test:e2e 收集 tests/e2e，用本机模拟后端完成可复现的浏览器验证。
 *
 * 代码结构与阅读顺序：
 * 1. 测试运行配置关闭并发并固定单 worker、超时。
 * 2. use 指定本机 baseURL、视口及失败保留 trace。
 * 3. webServer 启动测试夹具且不复用已有服务，projects 指定 Chromium。
 *
 * 维护注意事项：
 * 测试必须使用夹具端口，避免连上用户正在运行的生产会话；浏览器安装由环境准备负责。
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
