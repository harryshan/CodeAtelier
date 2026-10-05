/**
 * 给普通测试提供临时目录和真实文件工具，避免读写用户项目。
 *
 * 1. trackRunner 登记直接创建的工具，temp 创建并解析临时目录的真实路径，再登记清理范围。
 * 2. waitForApproval 监听 Engine 状态变更并检查指定任务，允许正常冷启动；任务提前结束或十秒未就绪时拒绝并移除监听。
 * 3. afterEach 先关闭真实读取线程池，再删除本文件创建的目录。
 * 4. fileFixture 创建工作区和配置目录，组装并登记 ToolRunner、ApprovalManager 和取消信号。
 * 5. 返回工具实例、审批列表、事件数组和控制器，供用例执行、批准或取消操作。
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
import type { Engine } from "../../src/agent/engine.js";
import type { Approval } from "../../src/shared/types.js";

const directories: string[] = [];
const runners: ToolRunner[] = [];

export function trackRunner(runner: ToolRunner) {
  runners.push(runner);

  return runner;
}

export async function temp() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ca-test-")),
  );

  directories.push(directory);

  return directory;
}

/** 审批出现是就绪条件；这些用例验证取消与恢复，没有一秒内启动的产品契约。 */
export function waitForApproval(engine: Engine, taskId: string) {
  return new Promise<Approval>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      engine.events.off("change", check);
    };

    const check = () => {
      const approval = engine.approvals
        .list()
        .find((item) => item.taskId === taskId);
      if (approval) {
        cleanup();
        resolve(approval);

        return;
      }

      const status = engine.store.task(taskId)?.status;
      if (status && !["queued", "running", "waiting"].includes(status)) {
        cleanup();
        reject(new Error(`任务在审批前结束：${status}`));
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("测试任务十秒内没有进入审批状态。"));
    }, 10_000);

    engine.events.on("change", check);
    check();
  });
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
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
  const runner = trackRunner(
    new ToolRunner({
      root,
      settings: config.settings,
      sessionId: "s",
      taskId: "t",
      signal: controller.signal,
      approvals,
      emit: (type, data) => events.push({ type, data }),
    }),
  );

  return { root, config, controller, approvals, events, runner };
}
