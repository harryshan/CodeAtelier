/**
 * 验证 ToolRunner 位于 Agent Runtime 时直接在既有 restricted token/Job 中创建工具进程，且不再嵌套调用逐工具 SandboxBroker。
 * 这里只验证 TypeScript 分流，不替代 Windows token/Job 或 Push Runner 夹具。
 *
 * 1. 普通 run_command 在既有 Runtime 权限内不再审批，使用本进程 shell并发布 sandboxed_tool_process PID。
 * 2. 扩展权限调用先由 adapter 准备，取得执行槽后才消费准备结果；Git push 查询在 Runtime 内完成，但结构化 PushSpec 经注入 adapter 等待独立 Push Runner。
 * 3. 注入的旧 SandboxBroker 若被调用会使测试失败，防止迁移后继续每条命令启动 supervisor。
 */

import { expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { Config } from "../src/config/config.js";
import { ToolRunner } from "../src/tools/tool-runner.js";
import { temp } from "./fixtures/helpers.js";

const run = promisify(execFile);

it("runs ordinary commands inside the existing Agent Runtime boundary", async () => {
  const root = await temp();
  const config = new Config(await temp());
  const executeCommand = vi.fn(() => {
    throw new Error("不应嵌套调用 SandboxBroker");
  });
  const events: Array<{ type: string; data: any }> = [];
  const requestApproval = vi.fn(async () => false);
  const runner = new ToolRunner({
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
    command: "node -e \"process.stdout.write('runtime-local')\"",
  });

  expect(result).toMatchObject({
    exitCode: 0,
    output: "runtime-local",
    sandbox: { mode: "sandboxed", applied: true },
  });
  expect(executeCommand).not.toHaveBeenCalled();
  expect(requestApproval).not.toHaveBeenCalled();
  expect(events).toContainEqual({
    type: "sandboxed_tool_process",
    data: { pid: expect.any(Number) },
  });
});

it("routes an explicit permission request to one broker capability runner", async () => {
  const root = await temp();
  const config = new Config(await temp());
  const executePrepared = vi.fn(async () => ({
    executionInstanceId: "capability-1",
    output: "elevated-result",
    exitCode: 0,
    truncated: false,
  }));
  const prepareRunWithPermissions = vi.fn(async () => executePrepared);
  const runner = new ToolRunner({
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
    command: "node external-task.js",
    permissions: {
      readRoots: [root],
      writeRoots: [],
      httpsHost: "example.test",
    },
    reason: "需要读取已审核的外部输入并调用固定服务。",
  };

  await expect(
    runner.forCall("capability-call").execute("run_with_permissions", request),
  ).resolves.toMatchObject({
    executionInstanceId: "capability-1",
    output: "elevated-result",
  });
  expect(prepareRunWithPermissions).toHaveBeenCalledWith(
    request,
    expect.any(AbortSignal),
    "capability-call",
  );
  expect(executePrepared).toHaveBeenCalledOnce();
});

it("waits for the broker push adapter while the agent runtime remains alive", async () => {
  const root = await temp();
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.name", "Runtime Test"], { cwd: root });
  await run("git", ["config", "user.email", "runtime@example.test"], {
    cwd: root,
  });
  await writeFile(`${root}/tracked.txt`, "tracked\n");
  await run("git", ["add", "tracked.txt"], { cwd: root });
  await run("git", ["commit", "-m", "fixture"], { cwd: root });
  await run(
    "git",
    ["remote", "add", "origin", "https://example.test/repo.git"],
    {
      cwd: root,
    },
  );
  await run("git", ["config", "branch.main.remote", "origin"], { cwd: root });
  await run("git", ["config", "branch.main.merge", "refs/heads/main"], {
    cwd: root,
  });
  const config = new Config(await temp());
  const executeCommand = vi.fn(() => {
    throw new Error("不应嵌套调用 SandboxBroker");
  });
  const gitPush = vi.fn(async () => ({
    output: "push-complete",
    exitCode: 0,
    truncated: false,
  }));
  const events: Array<{ type: string; data: any }> = [];
  const runner = new ToolRunner({
    root,
    sessionId: "session-1",
    taskId: "task-1",
    signal: new AbortController().signal,
    settings: config.settings,
    approvals: { request: async () => true },
    sandbox: { executeCommand } as never,
    executionBoundary: "agent-runtime",
    gitPush,
    emit: (type, data) => events.push({ type, data }),
  });

  await expect(
    runner.forCall("push-call").execute("git", { request: { action: "push" } }),
  ).resolves.toMatchObject({ output: "push-complete", exitCode: 0 });
  expect(gitPush).toHaveBeenCalledWith(
    expect.objectContaining({
      remote: "origin",
      remoteUrl: "https://example.test/repo.git",
      host: "example.test",
      refspec: "HEAD:refs/heads/main",
    }),
    expect.any(AbortSignal),
    "push-call",
  );
  expect(executeCommand).not.toHaveBeenCalled();
  expect(events.filter((event) => event.type === "git_output")).toEqual([]);
});
