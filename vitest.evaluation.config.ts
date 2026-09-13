/**
 * pnpm eval:test 使用的独立评测回归配置，只在用户要求时运行。
 *
 * 1. 设置测试端点和模型，避免依赖个人 .env。
 * 2. include 仅收集 evals 下的 .test.ts。
 * 3. 设置异步测试超时。
 *
 * 不能从 CI、默认 check 或服务启动流程调用此配置。
 */

import { defineConfig } from "vitest/config";

// 仅供手动运行，不属于默认 test/check。
export default defineConfig({
  test: {
    env: {
      CODEATELIER_BASE_URL: "http://127.0.0.1:9999/v1",
      CODEATELIER_MODEL: "test-model",
    },
    include: ["evals/**/*.test.ts"],
    testTimeout: 15000,
  },
});
