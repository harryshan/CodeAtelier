/**
 * 给普通测试提供临时目录和真实文件工具，避免读写用户项目。
 *
 * 1. temp 创建临时目录，解析真实路径后登记到清理列表。
 * 2. afterEach 删除本文件创建并登记的目录。
 * 3. fileFixture 创建工作区和配置目录，组装 ToolRunner、ApprovalManager 和取消信号。
 * 4. 返回工具实例、审批列表、事件数组和控制器，供用例执行、批准或取消操作。
 *
 * 不会自动批准工具请求；清理范围仅限夹具创建的目录。
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
