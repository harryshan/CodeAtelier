/**
 * 验证 ToolRunner 位于 Agent Runtime 时直接在既有 restricted token/Job 中创建工具进程，且不再嵌套调用逐工具 SandboxBroker。
 * 这里只验证 TypeScript 分流，不替代 Windows token/Job 或 Push Runner 夹具。
 *
 * 1. 普通 run_command 经审批后使用本进程 shell，发布 sandboxed_tool_process PID 并返回 sandboxed 状态。
 * 2. Git push 查询在 Runtime 内完成，但结构化 PushSpec 经注入 adapter 等待独立 Push Runner，不嵌套 supervisor。
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
  const runner = new ToolRunner({
    root,
    sessionId: "session-1",
    taskId: "task-1",
    signal: new AbortController().signal,
    settings: config.settings,
    approvals: { request: async () => true },
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
  expect(events).toContainEqual({
    type: "sandboxed_tool_process",
    data: { pid: expect.any(Number) },
  });
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
    emit: () => {},
  });

  await expect(
    runner.execute("git", { request: { action: "push" } }),
  ).resolves.toMatchObject({ output: "push-complete", exitCode: 0 });
  expect(gitPush).toHaveBeenCalledWith(
    expect.objectContaining({
      remote: "origin",
      remoteUrl: "https://example.test/repo.git",
      host: "example.test",
      refspec: "HEAD:refs/heads/main",
    }),
    expect.any(AbortSignal),
  );
  expect(executeCommand).not.toHaveBeenCalled();
});
