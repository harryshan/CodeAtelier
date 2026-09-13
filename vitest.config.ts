/**
 * 默认单元测试和回归测试配置，由 pnpm test、test:watch 和 check 使用。
 *
 * 1. 设置独立的测试端点和模型，避免依赖个人 .env。
 * 2. include 只收集 tests 下的 .test.ts。
 * 3. testTimeout 为文件、进程和服务相关的异步测试设置上限。
 *
 * 浏览器测试交给 Playwright；Evaluation 使用独立配置，不能加入这里的匹配范围。
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CODEATELIER_BASE_URL: "http://127.0.0.1:9999/v1",
      CODEATELIER_MODEL: "test-model",
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
  },
});
