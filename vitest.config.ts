/**
 * 默认单元测试和回归测试配置，由 pnpm test、test:coverage、test:watch 和 check 使用。
 *
 * 1. 声明固定的测试连接值；Vitest 父进程环境由 test-runner.ts 白名单隔离。
 * 2. include 只收集 tests 下的 .test.ts。
 * 3. coverage 由 test:coverage 显式启用，统计全部可测试的产品源码并生成 text、HTML 与 LCOV 报告。
 * 4. Windows 的文件级 worker 最多四个，避免各文件内的 PowerShell、SQLite/Runtime Worker 叠加超额并发；CLI 可显式覆盖以加压。
 * 5. testTimeout 保持异步测试原有上限，不以重试或加大时限掩盖失败。
 *
 * 浏览器测试交给 Playwright；Evaluation 使用独立配置，不能加入这里的匹配范围。
 */

import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      CODEATELIER_BASE_URL: "http://127.0.0.1:9999/v1",
      CODEATELIER_MODEL: "test-model",
      CODEATELIER_API_KEY: "",
      CODEATELIER_AUXILIARY_MODEL: "",
      CODEATELIER_AUXILIARY_REASONING_EFFORT: "",
    },
    include: ["tests/**/*.test.ts"],
    ...(process.platform === "win32"
      ? { maxWorkers: Math.min(4, availableParallelism()) }
      : {}),
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/evaluation/**"],
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
    },
    testTimeout: 15000,
  },
});
