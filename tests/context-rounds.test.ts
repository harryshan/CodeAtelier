/**
 * 验证压缩轮次策略和 90% 触发点，不连接模型服务。
 * 1. rounds 生成包含 reasoning、并行调用及完整结果的历史，检查 10% 向上取整与至少一轮。
 * 2. 容量检查只缩减完整轮次，用户原文/历史摘要和固定开销仍计入预算。
 * 3. 真实 ContextManager/Worker 使用内存存储，验证阈值前不调用摘要、阈值处提交 60% 内的视图。
 */
import { expect, it } from "vitest";
import { chooseCut, contextSize, roundStarts } from "../src/context/budget.js";
import { ContextManager } from "../src/context/context-manager.js";

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
  expect(chooseCut(rounds(count), 100000)).toBe(cut);
});

it("never splits the only round, including pending parallel calls", () => {
  expect(chooseCut(rounds(1), 100000)).toBeUndefined();
  expect(roundStarts(rounds(1).slice(0, 4))).toEqual([0]);
});

it("reduces whole rounds for capacity but never drops the final round", () => {
  const source = rounds(11);
  source[49].output = "x".repeat(5000);
  expect(chooseCut(source, 5000)).toBe(50);
  source[54].output = "x".repeat(5000);
  expect(chooseCut(source, 5000)).toBeUndefined();
  expect(
    chooseCut(rounds(11), 5000, contextSize, "x".repeat(3000)),
  ).toBeUndefined();
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
  expect(chooseCut(source, 10000, contextSize, "", [], notes)).toBe(8);
  source[0].content = "x".repeat(7000);
  expect(
    chooseCut(source, 10000, contextSize, "", [], new Set([source[0].content])),
  ).toBeUndefined();
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
      measure: () => 20000 * ratio,
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
      expect(contextSize(result, "", [])).toBeLessThanOrEqual(12000);
      expect(result.filter((item) => item.role === "user")).toEqual(
        source.filter((item) => item.role === "user"),
      );
    }
  },
);
