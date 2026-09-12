/**
 * 文件作用：提供字符容量估算和保持工具批次完整的历史切分逻辑。
 *
 * 模块协作与输入输出：
 * 供 ContextManager 选择可压缩的旧历史前缀，支持默认字符度量或调用方传入的 token 度量。
 *
 * 代码结构与执行顺序：
 * 1. contextSize 统计 instructions、tools 和 input 整体 JSON 的字符数。
 * 2. safeCuts 用 pending 集合跟踪调用与结果，只暴露不拆开未完成工具批次的切点。
 * 3. chooseCut 优先选择近期尾部低于预算四分之一的切点，否则取最后一个安全位置。
 *
 * 关键约束：
 * 返回 undefined 表示没有安全切点；保留用户原文和是否值得压缩由 ContextManager 进一步判断。
 */

/** 字符预算含指令、工具定义和输入的 JSON 包装，不代表模型 token 容量。 */
export function contextSize(
  input: any[],
  instructions: string,
  tools: any[],
): number {
  return JSON.stringify({ input, instructions, tools }).length;
}

/** 只在用户消息之前或整批工具结果之后切分，保守地保留响应协议项。 */
export function safeCuts(input: any[]): number[] {
  const pending = new Set<string>();
  const cuts: number[] = [];

  for (const [index, item] of input.entries()) {
    if (item.role === "user" && pending.size === 0 && index > 0) {
      cuts.push(index);
    }

    if (item.type === "function_call") {
      pending.add(item.call_id);
    }

    if (item.type === "function_call_output") {
      pending.delete(item.call_id);
      if (pending.size === 0 && index + 1 < input.length) {
        cuts.push(index + 1);
      }
    }
  }

  // 被覆盖的用户消息由管理器逐条原文保留，不参与摘要改写。
  return [...new Set(cuts)];
}

export function chooseCut(
  input: any[],
  limit: number,
  measure = contextSize,
): number | undefined {
  const cuts = safeCuts(input);

  return (
    cuts.find((cut) => measure(input.slice(cut), "", []) <= limit * 0.25) ??
    cuts.at(-1)
  );
}
