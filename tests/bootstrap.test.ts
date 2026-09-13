/**
 * 检查自举验收的命令审批是否只接受预先指定的那条测试命令。
 * 直接调用 approveTestCommand，不启动模型或子进程。
 *
 * 1. 用当前 Node 路径、固定目录和完整参数构造获准命令，检查能够通过。
 * 2. 分别改变程序、目录或参数，检查全部被拒绝。
 * 3. 检查损坏 JSON、null 和其他工具请求也会被拒绝。
 *
 * 命令名称相似不代表获得授权；这个测试不会运行自举验收脚本。
 */

import { expect, it } from "vitest";
import { approveTestCommand } from "../scripts/bootstrap/approval.js";

const workspace = "/evaluation/workspace";
const args = ["vitest.mjs", "run", "tests/config.test.ts", "--reporter=json"];
const request = { command: process.execPath, args, cwd: workspace };

it("approves only the exact evaluation test command", () => {
  expect(
    approveTestCommand("run_command", JSON.stringify(request), workspace, args),
  ).toBe(true);
});

it.each([
  { command: "cmd.exe" },
  { cwd: "/another/project" },
  { args: [...args, "--watch"] },
  { args: ["-e", "process.exit(0)"] },
])("rejects changes to the approved command: %j", (change) => {
  expect(
    approveTestCommand(
      "run_command",
      JSON.stringify({ ...request, ...change }),
      workspace,
      args,
    ),
  ).toBe(false);
});

it("rejects malformed descriptions and non-command approvals", () => {
  expect(approveTestCommand("run_command", "null", workspace, args)).toBe(
    false,
  );
  expect(approveTestCommand("run_command", "bad json", workspace, args)).toBe(
    false,
  );
  expect(
    approveTestCommand("write_file", JSON.stringify(request), workspace, args),
  ).toBe(false);
});
