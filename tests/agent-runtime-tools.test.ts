/**
 * 验证 ToolRunner 位于 Agent Runtime 时直接在既有 restricted token/Job 中创建工具进程，且不再嵌套调用逐工具 SandboxBroker。
 * 这里只验证 TypeScript 分流，不替代 Windows token/Job 或安装态 Git CLI 兼容性验证。
 *
 * 1. 普通 run_command 在既有 Runtime 权限内不再审批，不过滤 Git 命令或普通文本，使用本进程 shell 并发布 sandboxed_tool_process PID。
 * 2. 扩展权限调用不按 Git 关键词过滤，先由 adapter 审批准备，取得执行槽后才消费结果；夹具验证命令/理由/callId 原样传递、返回值与阶段顺序，拒绝或缺少 Runtime 身份/adapter 时不执行。
 *    旧 Git 工具入口拒绝执行，不自动转译成命令或转交 Broker。
 * 3. 注入的旧 SandboxBroker 若被调用会使测试失败，防止迁移后继续每条命令启动 supervisor。
 */

import { expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import { createTestRunner } from "./fixtures/helpers.js";
import { temp } from "./fixtures/helpers.js";

it.each([
  ["node -e \"process.stdout.write('runtime-local')\"", "runtime-local"],
  ["git --version", "git version"],
  ["echo ok | git --version", "git version"],
  ['echo "git status"', "git status"],
])(
  "runs %s inside the existing Agent Runtime boundary",
  async (command, output) => {
    const root = await temp();
    const config = new Config(await temp());
    const executeCommand = vi.fn(() => {
      throw new Error("不应嵌套调用 SandboxBroker");
    });
    const events: Array<{ type: string; data: any }> = [];
    const requestApproval = vi.fn(async () => false);
    const runner = createTestRunner({
      root,
      sessionId: "session-1",
      taskId: "task-1",
      signal: new AbortController().signal,
      settings: config.settings,
      approvals: { request: requestApproval },
      sandbox: { executeCommand } as never,
      executionBoundary: "agent-runtime",
      emit: (type, data) => events.push({ type, data }),
    });

    const result = await runner.execute("run_command", {
      command,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      output: expect.stringContaining(output),
      sandbox: { mode: "sandboxed", applied: true },
    });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "sandboxed_tool_process",
      data: { pid: expect.any(Number) },
    });
  },
);

it.each([
  "node external-task.js",
  "git --version",
  "echo ok | git --version",
  'echo "git status"',
  "Select-String -Pattern 'git' README.md",
])(
  "routes %s to one Broker host command without Git filtering",
  async (command) => {
    const root = await temp();
    const config = new Config(await temp());
    const stages: string[] = [];
    const executePrepared = vi.fn(async () => {
      stages.push("execute");

      return {
        executionInstanceId: "capability-1",
        output: "host-result",
        exitCode: 0,
        truncated: false,
      };
    });
    const prepareRunWithPermissions = vi.fn(async () => {
      stages.push("prepare");

      return executePrepared;
    });
    const onExecutionStart = async () => {
      stages.push("start");
    };

    const runner = createTestRunner({
      root,
      sessionId: "session-1",
      taskId: "task-1",
      signal: new AbortController().signal,
      settings: config.settings,
      approvals: { request: vi.fn(async () => false) },
      executionBoundary: "agent-runtime",
      prepareRunWithPermissions,
      emit: () => {},
    });
    const request = {
      command,
      reason: "需要 Broker 宿主权限运行外部工具。",
    };

    await expect(
      runner
        .forCall("capability-call")
        .execute("run_with_permissions", request, onExecutionStart),
    ).resolves.toMatchObject({
      executionInstanceId: "capability-1",
      output: "host-result",
      exitCode: 0,
      truncated: false,
    });
    expect(prepareRunWithPermissions).toHaveBeenCalledWith(
      request,
      expect.any(AbortSignal),
      "capability-call",
    );
    expect(prepareRunWithPermissions).toHaveBeenCalledOnce();
    expect(executePrepared).toHaveBeenCalledOnce();
    expect(stages).toEqual(["prepare", "start", "execute"]);
  },
);

it("does not start a Git-containing host command when Broker approval rejects", async () => {
  const config = new Config(await temp());
  const onExecutionStart = vi.fn(async () => {});
  const prepareRunWithPermissions = vi.fn(async () => {
    throw new Error("Broker approval rejected");
  });
  const runner = createTestRunner({
    root: await temp(),
    sessionId: "session-1",
    taskId: "task-1",
    signal: new AbortController().signal,
    settings: config.settings,
    approvals: { request: vi.fn(async () => false) },
    executionBoundary: "agent-runtime",
    prepareRunWithPermissions,
    emit: () => {},
  });

  await expect(
    runner.execute(
      "run_with_permissions",
      { command: "git --version", reason: "检查宿主 Git 版本。" },
      onExecutionStart,
    ),
  ).rejects.toThrow("Broker approval rejected");
  expect(prepareRunWithPermissions).toHaveBeenCalledOnce();
  expect(onExecutionStart).not.toHaveBeenCalled();
});

it.each(["host-process", "missing-adapter"])(
  "rejects permission requests with %s before preparing or executing",
  async (boundary) => {
    const config = new Config(await temp());
    const executePrepared = vi.fn(async () => {
      throw new Error("身份或 adapter 缺失时不应执行宿主命令");
    });
    const prepareRunWithPermissions = vi.fn(async () => executePrepared);
    const onExecutionStart = vi.fn(async () => {});
    const runner = createTestRunner({
      root: await temp(),
      sessionId: "session-1",
      taskId: "task-1",
      signal: new AbortController().signal,
      settings: config.settings,
      approvals: { request: vi.fn(async () => false) },
      ...(boundary === "missing-adapter"
        ? { executionBoundary: "agent-runtime" as const }
        : { prepareRunWithPermissions }),
      emit: () => {},
    });

    await expect(
      runner.execute(
        "run_with_permissions",
        { command: "git --version", reason: "检查宿主 Git 版本。" },
        onExecutionStart,
      ),
    ).rejects.toThrow("只可由已认证的 Agent Runtime 请求");
    expect(prepareRunWithPermissions).not.toHaveBeenCalled();
    expect(executePrepared).not.toHaveBeenCalled();
    expect(onExecutionStart).not.toHaveBeenCalled();
  },
);

it.each(["broker-host", "agent-runtime"] as const)(
  "rejects the retired Git tool before starting in %s",
  async (executionBoundary) => {
    const config = new Config(await temp());
    const start = vi.fn(async () => {});
    const emit = vi.fn();
    const prepareRunWithPermissions = vi.fn();
    const runner = createTestRunner({
      root: await temp(),
      sessionId: "session-1",
      taskId: "task-1",
      signal: new AbortController().signal,
      settings: config.settings,
      approvals: { request: async () => true },
      executionBoundary,
      prepareRunWithPermissions,
      emit,
    });

    await expect(
      runner.execute("git", { request: { action: "push" } }, start),
    ).rejects.toThrow("未知工具");
    expect(start).not.toHaveBeenCalled();
    expect(prepareRunWithPermissions).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  },
);
