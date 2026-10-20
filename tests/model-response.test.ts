/**
 * 验证宿主和 Runtime 共用的完整响应接收顺序，不访问数据库或模型服务。
 *
 * 1. fixture 用内存历史与可控回调模拟持久化，观察请求校准、正文写入、锚点保存及回复发布的顺序。
 * 2. 正常路径覆盖共享请求/历史数组、缺失 usage 和空回复，不改变原始协议条目。
 * 3. 写入失败用持久化日志证明后续阶段未执行，已追加历史不回滚且副作用不重试。
 */

import { expect, it } from "vitest";
import { acceptModelResponse } from "../src/agent/model-response.js";
import type { ModelResult } from "../src/providers/model-provider.js";

type Operations = Parameters<typeof acceptModelResponse>[1];

function fixture(failAt?: "append" | "anchor") {
  const input: unknown[] = [{ type: "message", content: "question" }];
  const sequence: string[] = [];
  const stored: unknown[] = [];
  const replies: string[] = [];
  const error = new Error("persistence failed");
  const operations: Operations = {
    input,
    requestInput: input,
    instructions: "rules",
    tools: [],
    calibration: {
      observe(actual, requestInput, instructions, tools) {
        expect(requestInput).toEqual([
          { type: "message", content: "question" },
        ]);
        expect(instructions).toBe("rules");
        expect(tools).toEqual([]);
        sequence.push(
          actual === undefined ? "observe:missing" : "observe:usage",
        );

        return undefined;
      },
      async save(anchor) {
        expect(anchor).toBeUndefined();
        sequence.push("anchor");
        if (failAt === "anchor") {
          throw error;
        }
      },
    },
    recordUsage() {
      sequence.push("usage");
    },
    async appendContext(output) {
      sequence.push("append");
      expect(input.slice(1)).toEqual(output);
      if (failAt === "append") {
        throw error;
      }

      stored.push(...output);
    },
    emitAssistant(text) {
      sequence.push("assistant");
      replies.push(text);
    },
  };

  return { operations, sequence, stored, replies, error };
}

const response: ModelResult = {
  output: [{ type: "opaque_provider_item", payload: { value: 1 } }],
  text: "answer",
  usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
};

it("calibrates before appending and publishes only after both saves", async () => {
  const state = fixture();
  await acceptModelResponse(response, state.operations);

  expect(state.sequence).toEqual([
    "observe:usage",
    "usage",
    "append",
    "anchor",
    "assistant",
  ]);
  expect(state.stored).toEqual(response.output);
  expect(state.stored[0]).toBe(response.output[0]);
  expect(state.replies).toEqual(["answer"]);
});

it("preserves output without synthesizing usage or an empty assistant event", async () => {
  const state = fixture();
  await acceptModelResponse(
    { output: response.output, text: "" },
    state.operations,
  );

  expect(state.sequence).toEqual(["observe:missing", "append", "anchor"]);
  expect(state.stored).toEqual(response.output);
  expect(state.replies).toEqual([]);
});

it.each(["append", "anchor"] as const)(
  "stops after %s failure without retry or rollback",
  async (stage) => {
    const state = fixture(stage);
    await expect(acceptModelResponse(response, state.operations)).rejects.toBe(
      state.error,
    );

    expect(state.sequence).toEqual(
      stage === "append"
        ? ["observe:usage", "usage", "append"]
        : ["observe:usage", "usage", "append", "anchor"],
    );
    expect(state.operations.input.slice(1)).toEqual(response.output);
    expect(state.stored).toEqual(stage === "append" ? [] : response.output);
    expect(state.replies).toEqual([]);
  },
);
