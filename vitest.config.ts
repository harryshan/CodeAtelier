/**
 * 文件作用：定义默认单元及回归测试范围。
 * 代码结构：通过 test.include 仅收集 tests 下的测试并设置超时；Evaluation 使用独立配置。
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
