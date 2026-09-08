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
