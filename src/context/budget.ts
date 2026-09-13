/**
 * 帮助 ContextManager 找到适合压缩的旧历史，同时保持工具调用和结果成对出现。
 * 默认按字符数估算大小，也接受调用方提供的 token 计量函数。
 *
 * 1. contextSize 计算 instructions、tools 和 input 序列化后的总字符数。
 * 2. safeCuts 跟踪尚未配齐结果的工具调用，只返回可以安全切开历史的位置。
 * 3. chooseCut 优先保留小于预算四分之一的近期历史；没有这样的切点时取最后一个安全位置。
 *
 * 返回 undefined 表示不能安全切分。是否值得压缩、怎样保留用户原文，由 ContextManager 决定。
 */

/** 计算整个请求 JSON 的字符数，包括指令和工具定义；这不是 token 数。 */
export function contextSize(
  input: any[],
  instructions: string,
  tools: any[],
): number {
  return JSON.stringify({ input, instructions, tools }).length;
}

/** 只在用户消息前或一批工具结果收齐后切开历史，避免拆散调用和结果。 */
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

  // 切点之前的用户消息由 ContextManager 另行保留原文，不交给摘要改写。
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
