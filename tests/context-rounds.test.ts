/**
 * 验证压缩轮次策略和 90% 触发点，不连接模型服务。
 * 1. rounds 生成包含 reasoning、并行调用及完整结果的历史，检查 10% 向上取整与至少一轮。
 * 2. 改变内容体积不会改变轮数切点，不调用候选 tokenizer。
 * 3. 真实 ContextManager/Worker 使用内存存储，验证 90% 触发、压缩后等待新实报，不立即重算新视图。
 */
import { expect, it, vi } from "vitest";
import { chooseCut, contextSize, roundStarts } from "../src/context/budget.js";
import { ContextManager } from "../src/context/context-manager.js";
import { summaryBudget } from "./fixtures/summary-budget.js";

function rounds(count: number): any[] {
  return Array.from({ length: count }, (_, index) => [
    { type: "reasoning", id: `reason-${index}` },
    {
      type: "function_call",
      call_id: `a-${index}`,
      name: "read_file",
      arguments: "{}",
    },
    {
      type: "function_call",
      call_id: `b-${index}`,
      name: "read_file",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: `a-${index}`, output: "a" },
    { type: "function_call_output", call_id: `b-${index}`, output: "b" },
  ]).flat();
}

it.each([
  [2, 5],
  [10, 45],
  [11, 45],
  [21, 90],
])("retains rounded-up ten percent of %i rounds", (count, cut) => {
  expect(chooseCut(rounds(count))).toBe(cut);
});

it("never splits the only round, including pending parallel calls", () => {
  expect(chooseCut(rounds(1))).toBeUndefined();
  expect(roundStarts(rounds(1).slice(0, 4))).toEqual([0]);
});

it("keeps the same two rounds regardless of their size", () => {
  const source = rounds(11);
  expect(chooseCut(source)).toBe(45);
  source[49].output = "x".repeat(500000);
  source[54].output = "x".repeat(500000);
  expect(chooseCut(source)).toBe(45);
});

it("merges consecutive user input and excludes archived summaries from the round count", () => {
  const source = [
    { role: "assistant", content: "old summary" },
    { role: "user", content: "first" },
    { role: "user", content: "correction" },
    ...rounds(1),
    { role: "user", content: "next" },
    { role: "user", content: "more" },
  ];
  const notes = new Set(["old summary"]);
  expect(roundStarts(source, notes)).toEqual([1, 8]);
  expect(chooseCut(source, notes)).toBe(8);
  source[0].content = "x".repeat(7000);
  expect(chooseCut(source, new Set([source[0].content]))).toBe(8);
});

it.each([0.899, 0.9])(
  "triggers summary only at ninety percent: %s",
  async (ratio) => {
    let calls = 0;
    let committed: any[] | undefined;
    const source = [
      { role: "user", content: "requirements" },
      { role: "assistant", content: "history ".repeat(1500) },
      { role: "user", content: "continue" },
    ];
    const measure = vi.fn(() => 20000 * ratio);
    const manager = new ContextManager({
      store: {
        latestContextSnapshotAsync: async () => undefined,
        eventsAsync: async () => [],
        contextSnapshotAsync: async () => undefined,
        compactContextAsync: async (_session, _snapshot, input) => {
          committed = input;
        },
      },
      sessionId: "session",
      model: "fixture",
      limit: 20000,
      measure,
      summaryBudget,
      provider: {
        async run() {
          calls++;

          return {
            output: [],
            text: JSON.stringify({
              completed: [],
              conclusions: [],
              verification: [],
              pending: [],
            }),
          };
        },
      },
      signal: new AbortController().signal,
      clean: (text) => text,
      notice: () => {},
      report: () => {},
    });
    const result = await manager.prepare(source, "", []);
    if (ratio < 0.9) {
      expect(result).toBe(source);
      expect(calls).toBe(0);
      expect(committed).toBeUndefined();
    } else {
      expect(calls).toBeGreaterThan(0);
      expect(result).toEqual(committed);
      expect(contextSize(result, "", [])).toBeLessThan(
        contextSize(source, "", []),
      );
      expect(measure).toHaveBeenCalledTimes(1);
      expect(manager.request(result, "", []).after).toBeUndefined();
      manager.observeUsage(undefined);
      expect(await manager.prepare(result, "", [])).toBe(result);
      expect(measure).toHaveBeenCalledTimes(1);
      manager.observeUsage({
        input_tokens: -1,
        output_tokens: 0,
        total_tokens: 0,
      });
      expect(manager.request(result, "", []).after).toBeUndefined();
      measure.mockReturnValue(100);
      manager.observeUsage({
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
      });
      expect(await manager.prepare(result, "", [])).toBe(result);
      expect(measure).toHaveBeenCalledTimes(2);
      expect(result.filter((item) => item.role === "user")).toEqual(
        source.filter((item) => item.role === "user"),
      );
    }
  },
);
