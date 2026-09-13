/**
 * 判断自举验收提出的命令是否与预先允许的测试命令完全一致。
 * 验收脚本和普通单元测试共用 approveTestCommand，输入工具名、JSON 描述、目录和参数。
 *
 * 1. 解析描述，逐项比较 run_command、当前 Node 路径、工作目录和完整参数数组。
 * 2. 全部相同才返回 true；解析失败或任一项不同都返回 false。
 *
 * 这里只做匹配，不执行命令。额外参数和 shell 包装都不属于这份授权。
 */

/** 仅预授权验收副本中精确匹配的测试命令，不接受 shell 或额外参数。 */
export function approveTestCommand(
  tool: string,
  description: string,
  workspace: string,
  args: string[],
): boolean {
  try {
    const detail = JSON.parse(description);

    return (
      tool === "run_command" &&
      detail.command === process.execPath &&
      detail.cwd === workspace &&
      JSON.stringify(detail.args) === JSON.stringify(args)
    );
  } catch {
    return false;
  }
}
