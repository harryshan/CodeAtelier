/**
 * 文件作用：验证自举脚本的精确命令预授权边界。
 *
 * 使用场景与输入输出：
 * 直接测试 approveTestCommand 纯函数，使用固定工作区、当前 Node 路径及完整参数数组，不启动模型或子进程。
 *
 * 代码结构与阅读顺序：
 * 1. 先构造唯一允许的测试命令，断言精确匹配可以通过。
 * 2. 参数化修改可执行文件、工作区和参数，验证每种变化都会拒绝。
 * 3. 最后覆盖 null、损坏 JSON 和非 run_command 请求。
 *
 * 维护注意事项：
 * 保留精确相等边界，不以测试命令名称相似作为授权依据；该普通回归不运行自举评测。
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
