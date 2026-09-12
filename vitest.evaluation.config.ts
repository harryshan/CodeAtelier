/**
 * 文件作用：提供仅手动调用的 Evaluation 回归测试配置。
 *
 * 使用场景与输入输出：
 * 只供显式 pnpm eval:test 入口使用，和默认 Vitest 配置分开维护。
 *
 * 代码结构与阅读顺序：
 * 1. 导入 defineConfig，声明仅收集 evals 下的 .test.ts。
 * 2. 使用独立测试端点和模型环境值，不读取个人 .env。
 * 3. 为评测适配器的异步回归设置超时，保持文件内 opt-in 提示。
 *
 * 维护注意事项：
 * 不得在 CI、默认 check 或服务启动时引用此配置；本次注释更新不运行该套件。
 */

import { defineConfig } from "vitest/config";

// Opt-in only: this suite is excluded from the default test/check commands.
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
