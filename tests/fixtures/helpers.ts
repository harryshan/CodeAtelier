/**
 * 文件作用：为测试提供隔离的临时目录和文件工具环境。
 *
 * 使用场景与输入输出：
 * 供普通回归测试共享隔离目录及生产文件工具组合，避免测试依赖用户项目。
 *
 * 代码结构与阅读顺序：
 * 1. temp 在系统临时目录下创建并 realpath 规范化目录，加入清理列表。
 * 2. afterEach 仅删除该列表中由夹具创建的目录。
 * 3. fileFixture 分别创建工作区与配置目录，组装 AbortController、ApprovalManager 和 ToolRunner。
 * 4. 返回 runner、审批列表入口、事件数组及控制器，供测试驱动批准、取消和结果核对。
 *
 * 维护注意事项：
 * 夹具不自动批准操作；资源必须只来自本测试创建的路径。
 */

import { afterEach } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config } from "../../src/config/config.js";
import { ToolRunner } from "../../src/tools/tool-runner.js";
import { ApprovalManager } from "../../src/permissions/approval-manager.js";

const directories: string[] = [];

export async function temp() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ca-test-")),
  );

  directories.push(directory);

  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

export async function fileFixture() {
  const root = await temp();
  const config = new Config(await temp());
  const controller = new AbortController();
  const approvals = new ApprovalManager(() => {});
  const events: { type: string; data: any }[] = [];
  const runner = new ToolRunner({
    root,
    settings: config.settings,
    sessionId: "s",
    taskId: "t",
    signal: controller.signal,
    approvals,
    emit: (type, data) => events.push({ type, data }),
  });

  return { root, config, controller, approvals, events, runner };
}
