/**
 * 文件作用：为自举验收副本限定可预授权的测试命令。
 *
 * 使用场景与输入输出：
 * 被自举脚本及普通纯函数回归共用，输入审批工具名、JSON 描述、预期目录和参数数组。
 *
 * 代码结构与阅读顺序：
 * 1. approveTestCommand 先解析描述，再同时比较 run_command、process.execPath、cwd 和完整 args。
 * 2. 只有所有字段精确一致才返回 true，解析异常直接返回 false。
 *
 * 维护注意事项：
 * 不接受额外参数或 shell 包装；函数只匹配许可，不执行命令，也不意味着批准其他工具。
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
