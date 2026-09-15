/**
 * 判断自举验收提出的命令是否与预先允许的测试命令完全一致。
 * 验收脚本和普通单元测试共用 approveTestCommand，输入工具名、JSON 描述、目录和完整命令文本。
 *
 * 1. 解析描述，逐项比较 run_command、工作目录和唯一获准的 command 字符串。
 * 2. 全部相同才返回 true；解析失败或任一项不同都返回 false。
 *
 * 这里只做匹配，不执行命令。shell 由产品执行器内部封装，额外 shell 语法不属于这份授权。
 */

/** 仅预授权验收副本中精确匹配的测试命令，不接受其他命令文本。 */
export function approveTestCommand(
  tool: string,
  description: string,
  workspace: string,
  command: string,
): boolean {
  try {
    const detail = JSON.parse(description);

    return (
      tool === "run_command" &&
      detail.command === command &&
      detail.cwd === workspace
    );
  } catch {
    return false;
  }
}
