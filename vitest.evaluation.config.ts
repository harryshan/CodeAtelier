/**
 * 文件作用：提供仅手动调用的 Evaluation 回归测试配置。
 * 代码结构：单独收集 evals 下的测试并设置超时，与默认 test 和 check 的测试范围分离。
 */

import { defineConfig } from "vitest/config";

// Opt-in only: this suite is excluded from the default test/check commands.
export default defineConfig({
  test: { include: ["evals/**/*.test.ts"], testTimeout: 15000 },
});
