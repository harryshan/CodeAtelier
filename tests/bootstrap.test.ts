/**
 * 文件作用：验证自举脚本的精确命令预授权边界。
 * 代码结构：先测试正确命令及参数匹配，再覆盖格式损坏和非命令审批的拒绝；不执行真实模型评测。
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
