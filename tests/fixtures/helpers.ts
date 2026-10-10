/**
 * 给普通测试提供临时目录和真实文件工具，避免读写用户项目。
 *
 * 1. createTestRunner 连接测试取消并跟踪根/forCall 操作；trackRunner 为已有实例登记等待与关闭。
 *    temp 在创建目录前捕获所属测试，登记后再解析真实路径，取消后的晚返回也会清理。
 * 2. waitForApproval 监听 Engine 状态变更并检查指定任务，允许正常冷启动；任务提前结束或十秒未就绪时拒绝并移除监听。
 * 3. TestResources 的 afterEach 取消并排空在途操作、关闭资源，最后删除本测试的目录。
 * 4. fileFixture 创建工作区和配置目录，组装并登记 ToolRunner、ApprovalManager 和取消信号。
 * 5. 返回工具实例、审批列表、事件数组和控制器，供用例执行、批准或取消操作。
 *
 * 不会自动批准工具请求；清理范围仅限夹具创建的目录。
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { currentTestResources, type TestResources } from "./test-resources.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { Config } from "../../src/config/config.js";
import { ToolRunner, type ToolContext } from "../../src/tools/tool-runner.js";
import { ApprovalManager } from "../../src/permissions/approval-manager.js";
import type { Engine } from "../../src/agent/engine.js";
import type { Approval } from "../../src/shared/types.js";

function trackExecutions(runner: ToolRunner, scope: TestResources) {
  const execute = runner.execute.bind(runner);
  const forCall = runner.forCall.bind(runner);
  runner.execute = (...args) => scope.track(() => execute(...args));
  runner.forCall = (callId) => trackExecutions(forCall(callId), scope);

  return runner;
}

export function trackRunner(runner: ToolRunner) {
  const scope = currentTestResources();
  scope.defer(() => runner.close());

  return trackExecutions(runner, scope);
}

export function createTestRunner(context: ToolContext) {
  const scope = currentTestResources();

  return trackRunner(
    new ToolRunner({
      ...context,
      signal: AbortSignal.any([context.signal, scope.signal]),
    }),
  );
}

export function temp() {
  const scope = currentTestResources();

  return scope.track(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ca-test-"));
    scope.directory(directory);
    const resolved = await realpath(directory);
    scope.assertOpen();

    return resolved;
  });
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

export async function fileFixture() {
  const root = await temp();
  const config = new Config(await temp());
  const controller = new AbortController();
  const approvals = new ApprovalManager(() => {});
  const events: { type: string; data: any }[] = [];
  const runner = createTestRunner({
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
