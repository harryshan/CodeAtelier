/**
 * 文件作用：定义默认单元及回归测试范围。
 *
 * 使用场景与输入输出：
 * 供默认 pnpm test/test:watch 与 check 使用，只定义常规回归的收集范围。
 *
 * 代码结构与阅读顺序：
 * 1. 导入 defineConfig 并导出 test 配置。
 * 2. include 仅匹配 tests 下的 .test.ts，testTimeout 为异步文件、进程及服务场景设置等待上限。
 *
 * 维护注意事项：
 * 浏览器 .spec.ts 由 Playwright 执行；evals 使用独立配置，不能扩展默认 glob 把 Evaluation 纳入。
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
