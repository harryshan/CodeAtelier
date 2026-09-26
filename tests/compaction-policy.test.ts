/**
 * 验证摘要契约与完整上下文容量验收，不依赖真实模型或个人历史。
 * 通过 summarize 和真实 CompactionWorkerClient 驱动生产解析与压缩路径。
 *
 * 1. 摘要响应覆盖长 JSON、多结论、多来源，以及仍必须拒绝的结构和来源错误。
 * 2. 保底用例验证强制整理也按实际容量保留完整用户要求和工具批次。
 * 3. Worker 用例保留较大的用户原文，检查小幅但真实的压缩可提交，超容量或无收益仍拒绝。
 * 所有 Worker 均在 finally 中终止；不写会话数据库、不执行工具、不请求模型服务。
 */

import { expect, it } from "vitest";
import { summarize } from "../src/context/compactor.js";
import { CompactionWorkerClient } from "../src/context/compaction-worker-client.js";
import { contextSize } from "../src/context/budget.js";
import type { ContextSnapshot } from "../src/context/types.js";
import { ContextManager } from "../src/context/context-manager.js";

const emptySummary = {
  completed: [],
  conclusions: [],
  verification: [],
  pending: [],
};
const signal = new AbortController().signal;

async function parseSummary(text: string) {
  return summarize(
    {
      async run() {
        return { output: [], text };
      },
    },
    [
      {
        role: "user",
        content: JSON.stringify(
          Array.from({ length: 33 }, (_, index) => ({ index })),
        ),
      },
    ],
    signal,
    (value) => value,
    () => {},
  );
}

it("accepts grounded summaries over 8000 characters with more than twenty facts and sources", async () => {
  const facts = Array.from({ length: 21 }, () => ({
    text: "已核实的历史结论".repeat(30),
    sources: Array.from({ length: 33 }, (_, index) => index),
  }));
  const value = {
    completed: facts,
    conclusions: facts,
    verification: facts,
    pending: facts,
  };
  const text = JSON.stringify(value);
  expect(text.length).toBeGreaterThan(8000);
  expect(await parseSummary(text)).toEqual(value);
});

it.each([
  "```json\n{}\n```",
  JSON.stringify({ ...emptySummary, extra: [] }),
  JSON.stringify({ ...emptySummary, pending: [{ text: "", sources: [0] }] }),
  JSON.stringify({
    ...emptySummary,
    pending: [{ text: "x".repeat(2001), sources: [0] }],
  }),
  JSON.stringify({ ...emptySummary, pending: [{ text: "fact", sources: [] }] }),
  JSON.stringify({
    ...emptySummary,
    pending: [{ text: "fact", sources: [33] }],
  }),
  JSON.stringify({
    ...emptySummary,
    pending: [{ text: "fact", sources: [0.5] }],
  }),
])(
  "continues rejecting malformed or ungrounded summaries: %s",
  async (text) => {
    await expect(parseSummary(text)).rejects.toThrow();
  },
);

it.each([false, true])(
  "retains requirements above ninety percent of capacity during fallback, force=%s",
  async (force) => {
    const input = [
      { role: "user", content: "u".repeat(9300) },
      {
        type: "function_call",
        call_id: "call",
        name: "run_command",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call",
        output: "x".repeat(5000),
      },
      { role: "assistant", content: "Verification remains pending." },
    ];
    let saved: ContextSnapshot | undefined;
    const manager = new ContextManager({
      sessionId: "session",
      model: "test",
      limit: 10000,
      signal,
      clean: (text) => text,
      notice: () => {},
      report: () => {},
      provider: {
        async run() {
          throw new Error("summary unavailable");
        },
      },
      store: {
        async latestContextSnapshotAsync() {
          return undefined;
        },
        async contextSnapshotAsync() {
          return undefined;
        },
        async eventsAsync() {
          return [];
        },
        async compactContextAsync(_session, snapshot) {
          saved = snapshot;
        },
      },
    });
    const result = await manager.prepare(input, "rules", [], force);
    expect(contextSize(result, "rules", [])).toBeGreaterThan(9000);
    expect(contextSize(result, "rules", [])).toBeLessThanOrEqual(10000);
    expect(result).toContainEqual(input[0]);
    expect(result).toContainEqual(input.at(-1));
    expect(saved?.stage).toBe("fallback");
    expect(saved?.source).toEqual(input);
  },
);

it.each([
  { noteLength: 1100, originalLength: 1500, accepted: true },
  { noteLength: 2500, originalLength: 1500, accepted: false },
  { noteLength: 4000, originalLength: 8000, accepted: false },
])(
  "checks actual capacity and reduction for a summary of $noteLength characters",
  async ({ noteLength, originalLength, accepted }) => {
    const worker = new CompactionWorkerClient();
    const input = [
      { role: "user", content: "u".repeat(6500) },
      { role: "assistant", content: "a".repeat(originalLength) },
      { role: "user", content: "next" },
    ];
    const beforeAmount = contextSize(input, "rules", []);
    const common = {
      measurement: { unit: "characters" },
      limit: 10000,
      instructions: "rules",
      tools: [],
    };
    try {
      const prepared = await worker.request<{ planned: boolean }>(
        "prepare",
        { ...common, input, events: [], snapshots: [] },
        signal,
      );
      expect(prepared.planned).toBe(true);
      const transformed = await worker.request<{ requiresSummary: boolean }>(
        "transform",
        {
          ...common,
          snapshotId: "snapshot",
          hashes: [],
          trustedNotes: [],
          beforeAmount,
        },
        signal,
      );
      expect(transformed.requiresSummary).toBe(true);
      const result = worker.request<{
        input: unknown[];
        snapshot: ContextSnapshot;
      }>(
        "finalize",
        {
          ...common,
          id: "snapshot",
          sessionId: "session",
          parentId: null,
          model: "test",
          unit: "characters",
          beforeAmount,
          note: "n".repeat(noteLength),
          summaries: [],
        },
        signal,
      );
      if (accepted) {
        const compacted = await result;
        const after = contextSize(compacted.input, "rules", []);
        expect(after).toBeGreaterThan(6000);
        expect(after).toBeGreaterThan(beforeAmount * 0.9);
        expect(after).toBeLessThan(beforeAmount);
        expect(after).toBeLessThanOrEqual(10000);
        expect(compacted.snapshot.source).toEqual(input);
      } else {
        await expect(result).rejects.toThrow();
      }
    } finally {
      await worker.close();
    }
  },
);
