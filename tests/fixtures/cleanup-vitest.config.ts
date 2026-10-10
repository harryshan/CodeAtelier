/**
 * 资源清理回归的独立子进程配置，由 fixture-cleanup.test.ts 显式选择。
 * 1. 只收集故意超时的 .case.ts，不混入产品单测或 Evaluation。
 * 2. 单 worker 隔离取消/清理顺序；hook 时限用于真实命令冷启动与失败善后，不改变默认测试配置。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/fixtures/cleanup-timeout.case.ts"],
    maxWorkers: 1,
    hookTimeout: 30_000,
  },
});
