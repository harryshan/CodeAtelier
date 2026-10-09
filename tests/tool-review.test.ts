/**
 * 检查宿主与 Runtime 共用的主模型状态审视适配器，不访问真实模型。
 * 1. 模拟 provider 记录输入、输出及 usage，确认请求不携带工具、不追加主对话。
 * 2. 验证严格 continue/stop、凭据脱敏、callId 归属与失败保持等待。
 * 3. 取消后的迟到模型决定不得产生中断通知。
 */
import { expect, it, vi } from "vitest";
import { createToolReviewer } from "../src/agent/tool-review.js";
import type { ModelProvider } from "../src/providers/model-provider.js";

const status = {
  elapsedMs: 300000,
  latestOutput: "secret-value-123 latest output",
  outputChars: 50,
  outputTruncated: false,
  silentMs: 0,
};

it.each(["continue", "stop"] as const)(
  "uses a tool-free main model request and records %s with its call id",
  async (action) => {
    const run = vi.fn<ModelProvider["run"]>().mockResolvedValue({
      output: [],
      text: JSON.stringify({ action, reason: "进程状态已检查" }),
      usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
    });
    const emit = vi.fn();
    const review = createToolReviewer({
      provider: { run },
      prompt: "run tests",
      secrets: ["secret-value-123"],
      emit,
    });
    expect(
      await review(
        {
          name: "run_command",
          arguments: { command: "test" },
          callId: "call-1",
        },
        status,
        new AbortController().signal,
      ),
    ).toEqual({ action, reason: "进程状态已检查" });
    expect(run.mock.calls[0]![2]).toEqual([]);
    expect(JSON.stringify(run.mock.calls)).not.toContain("secret-value-123");
    expect(JSON.stringify(run.mock.calls)).toContain("latest output");
    expect(emit).toHaveBeenCalledWith(
      "model_usage",
      expect.objectContaining({
        purpose: "tool_review",
        callId: "call-1",
        total_tokens: 60,
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      "notice",
      expect.objectContaining({ action, callId: "call-1" }),
    );
  },
);

it.each([
  "not json",
  '{"action":"restart","reason":"wrong"}',
  '{"action":"stop"}',
])("continues on malformed decision %s", async (text) => {
  const emit = vi.fn();
  const review = createToolReviewer({
    provider: { run: async () => ({ output: [], text }) },
    prompt: "test",
    emit,
  });
  expect(
    await review(
      { name: "mcp", arguments: {}, callId: "mcp-1" },
      status,
      new AbortController().signal,
    ),
  ).toMatchObject({ action: "continue" });
  expect(emit).toHaveBeenCalledWith(
    "notice",
    expect.objectContaining({ reviewFailed: true, callId: "mcp-1" }),
  );
});

it("ignores a late stop after the execution ends", async () => {
  const controller = new AbortController();
  const emit = vi.fn();
  const review = createToolReviewer({
    provider: {
      run: async () => {
        controller.abort(new Error("finished"));

        return { output: [], text: '{"action":"stop","reason":"late"}' };
      },
    },
    prompt: "test",
    emit,
  });
  await expect(
    review(
      { name: "git", arguments: {}, callId: "git-1" },
      status,
      controller.signal,
    ),
  ).rejects.toThrow("finished");
  expect(emit.mock.calls.some(([type]) => type === "notice")).toBe(false);
});
