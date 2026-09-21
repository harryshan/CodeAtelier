/**
 * 验证 ToolRunner 位于 Agent Runtime 时直接在既有 restricted token/Job 中创建工具进程，且不再嵌套调用逐工具 SandboxBroker。
 * 这里只验证 TypeScript 分流，不替代 Windows token/Job 或 Push Runner 夹具。
 *
 * 1. 普通 run_command 经审批后使用本进程 shell，发布 sandboxed_tool_process PID 并返回 sandboxed 状态。
 * 2. 注入的旧 SandboxBroker 若被调用会使测试失败，防止迁移后继续每条命令启动 supervisor。
 */

import { expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import { ToolRunner } from "../src/tools/tool-runner.js";
import { temp } from "./fixtures/helpers.js";

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
