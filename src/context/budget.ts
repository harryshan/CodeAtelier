/**
 * 帮助 ContextManager 找到适合压缩的旧历史，同时保持工具调用和结果成对出现。
 * 默认按字符数估算大小，也接受调用方提供的 token 计量函数。
 *
 * 1. contextSize 计算 instructions、tools 和 input 序列化后的总字符数。
 * 2. safeCuts 跟踪尚未配齐结果的工具调用，只返回可以安全切开历史的位置。
 * 3. roundStarts 按完整工具往返和用户边界重建轮次，合并连续用户消息并排除历史摘要。
 * 4. chooseCut 保留最后 10% 轮次（向上取整，至少一轮）；必留材料超出 60% 时逐轮减少。
 *    历史没有请求 ID 边界，无法区分的连续模型记录保守合并；末尾待响应用户输入算当前轮。
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

/** 重建当前活动历史的轮次；旧摘要不是新的模型请求，不能放大保留轮数。 */
export function roundStarts(input: any[], notes = new Set<string>()): number[] {
  const boundaries = [0, ...safeCuts(input), input.length];
  const starts: number[] = [];
  let pendingStart: number | undefined;

  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const items = input
      .slice(start, end)
      .filter(
        (item) => !(item.role === "assistant" && notes.has(item.content)),
      );
    if (items.length === 0) {
      continue;
    }

    pendingStart ??= start;
    if (items.some((item) => item.role !== "user")) {
      starts.push(pendingStart);
      pendingStart = undefined;
    }
  }

  // 未发送的新用户要求属于下一轮；连续追加的用户消息不各算一轮。
  if (pendingStart !== undefined) {
    starts.push(pendingStart);
  }

  return starts;
}

export function chooseCut(
  input: any[],
  limit: number,
  measure = contextSize,
  instructions = "",
  tools: any[] = [],
  notes = new Set<string>(),
): number | undefined {
  const starts = roundStarts(input, notes);
  const keep = Math.max(1, Math.ceil(starts.length * 0.1));
  const candidates = starts.slice(-keep).filter((cut) => cut > 0);

  // 轮次决定优先切点；计量只负责容量验收，不能为凑预算拆开最后一轮。
  return candidates.find((cut) => {
    const retained = input
      .slice(0, cut)
      .filter(
        (item) =>
          item.role === "user" ||
          (item.role === "assistant" && notes.has(item.content)),
      );

    return (
      measure([...retained, ...input.slice(cut)], instructions, tools) <
      limit * 0.6
    );
  });
}
