/**
 * 文件作用：提供字符容量估算和保持工具批次完整的历史切分逻辑。
 * 代码结构：先计算上下文大小，再枚举安全切点，最后按预算选择保留近期上下文的分界。
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
