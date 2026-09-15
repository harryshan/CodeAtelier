/**
 * 检查自举验收的命令审批是否只接受预先指定的那条测试命令。
 * 直接调用 approveTestCommand，不启动模型或子进程。
 *
 * 1. 用固定目录和完整命令文本构造获准命令，检查能够通过。
 * 2. 分别改变命令或目录，检查全部被拒绝。
 * 3. 检查损坏 JSON、null 和其他工具请求也会被拒绝。
 *
 * 命令名称相似不代表获得授权；这个测试不会运行自举验收脚本。
 */

import { expect, it } from "vitest";
import { approveTestCommand } from "../scripts/bootstrap/approval.js";

const workspace = "/evaluation/workspace";
const command =
  '"node" "vitest.mjs" "run" "tests/config.test.ts" "--reporter=json"';
const request = { command, cwd: workspace };

it("approves only the exact evaluation test command", () => {
  expect(
    approveTestCommand(
      "run_command",
      JSON.stringify(request),
      workspace,
      command,
    ),
  ).toBe(true);
});

it.each([
  { command: "node --test" },
  { cwd: "/another/project" },
  { command: command + " --watch" },
])("rejects changes to the approved command: %j", (change) => {
  expect(
    approveTestCommand(
      "run_command",
      JSON.stringify({ ...request, ...change }),
      workspace,
      command,
    ),
  ).toBe(false);
});

it("rejects malformed descriptions and non-command approvals", () => {
  expect(approveTestCommand("run_command", "null", workspace, command)).toBe(
    false,
  );
  expect(
    approveTestCommand("run_command", "bad json", workspace, command),
  ).toBe(false);
  expect(
    approveTestCommand(
      "edit_files",
      JSON.stringify(request),
      workspace,
      command,
    ),
  ).toBe(false);
});
