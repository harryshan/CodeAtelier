/**
 * 以可控模型和内存历史验证宿主与 Runtime 共用的轮次控制，不启动真实模型或命令。
 *
 * 1. fixture 记录阶段顺序与已保存历史，用来证明工具在完整响应持久化后执行，下一轮看得到结果。
 * 2. 重试用例沿用真实有界等待验证普通重试上限、超限恢复的任务级次数和连续 attempt 编号。
 * 3. 失败用例验证保存/工具失败不重放、取消阻止下一轮，以及无效图与正常工具耗尽预算的终态区分。
 */

import { expect, it } from "vitest";
import { runModelLoop } from "../src/agent/model-loop.js";
import { ModelError } from "../src/providers/model-error.js";
import type { ModelResult } from "../src/providers/model-provider.js";

const toolResponse: ModelResult = {
  text: "",
  output: [
    {
      type: "function_call",
      call_id: "read",
      name: "read_file",
      arguments: "{}",
    },
  ],
};
const finalResponse: ModelResult = { text: "done", output: [] };

function fixture(responses: Array<ModelResult | Error>) {
  const events: string[] = [];
  const history: unknown[] = [];
  const controller = new AbortController();
  const operations: Parameters<typeof runModelLoop>[0] = {
    maxSteps: 3,
    signal: controller.signal,
    async prepareStep(step) {
      events.push(`prepare:${step}`);
    },
    async request(attempt) {
      events.push(`request:${attempt}`);
      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }

      if (!response) {
        throw new Error("unexpected model request");
      }

      return response;
    },
    onRetry(_error, attempt) {
      events.push(`retry:${attempt}`);
    },
    async prepareOverflow() {
      events.push("compact");
    },
    async acceptResponse(response) {
      events.push("save");
      history.push(...response.output);
    },
    async executeTools(calls) {
      events.push("tools");
      expect(history).toContainEqual(calls[0]);
      history.push({
        type: "function_call_output",
        call_id: calls[0].call_id,
        output: "read result",
      });

      return "executed";
    },
    complete() {
      events.push("complete");
    },
  };

  return { operations, events, history, controller };
}

it("saves a response before tools and finishes after the next text response", async () => {
  const { operations, events, history } = fixture([
    toolResponse,
    finalResponse,
  ]);

  expect(await runModelLoop(operations)).toBe("completed");
  expect(events).toEqual([
    "prepare:1",
    "request:1",
    "save",
    "tools",
    "prepare:2",
    "request:1",
    "save",
    "complete",
  ]);
  expect(history).toContainEqual({
    type: "function_call_output",
    call_id: "read",
    output: "read result",
  });
});

it("keeps attempts continuous across transient retry and overflow recovery", async () => {
  const { operations, events } = fixture([
    new ModelError("temporary", true, "server_error"),
    new ModelError("overflow", false, "context_length_exceeded"),
    toolResponse,
    finalResponse,
  ]);
  const result = runModelLoop(operations);

  expect(await result).toBe("completed");
  expect(events).toEqual([
    "prepare:1",
    "request:1",
    "retry:1",
    "request:2",
    "compact",
    "request:3",
    "save",
    "tools",
    "prepare:2",
    "request:1",
    "save",
    "complete",
  ]);
});

it("stops after the existing two transient retries without executing tools", async () => {
  const failure = new ModelError("temporary", true, "server_error");
  const { operations, events } = fixture([
    failure,
    failure,
    failure,
    finalResponse,
  ]);
  const result = expect(runModelLoop(operations)).rejects.toBe(failure);
  await result;

  expect(events).toEqual([
    "prepare:1",
    "request:1",
    "retry:1",
    "request:2",
    "retry:2",
    "request:3",
  ]);
});

it("allows only one overflow recovery across the entire task", async () => {
  const failure = new ModelError("overflow", false, "context_length_exceeded");
  const { operations, events } = fixture([failure, toolResponse, failure]);

  await expect(runModelLoop(operations)).rejects.toBe(failure);
  expect(events).toEqual([
    "prepare:1",
    "request:1",
    "compact",
    "request:2",
    "save",
    "tools",
    "prepare:2",
    "request:1",
  ]);
});

it.each(["acceptResponse", "executeTools"] as const)(
  "does not retry model or tool side effects when %s fails",
  async (phase) => {
    const { operations, events } = fixture([toolResponse, finalResponse]);
    const failure = new ModelError("save failed", true, "server_error");
    operations[phase] = async () => {
      events.push("failure");
      throw failure;
    };

    await expect(runModelLoop(operations)).rejects.toBe(failure);
    expect(events).toEqual(
      phase === "acceptResponse"
        ? ["prepare:1", "request:1", "failure"]
        : ["prepare:1", "request:1", "save", "failure"],
    );
  },
);

it("does not start the next model step after cancellation", async () => {
  const { operations, events, controller } = fixture([
    toolResponse,
    finalResponse,
  ]);
  operations.executeTools = async () => {
    controller.abort(new Error("stop"));

    return "executed";
  };

  await expect(runModelLoop(operations)).rejects.toThrow("stop");
  expect(events).toEqual(["prepare:1", "request:1", "save"]);
});

it.each(["executed", "invalid"] as const)(
  "reports budget exhaustion after an %s batch without another request",
  async (batch) => {
    const { operations, events } = fixture([toolResponse, finalResponse]);
    operations.maxSteps = 1;
    operations.executeTools = async () => batch;

    expect(await runModelLoop(operations)).toBe(
      batch === "invalid" ? "invalid-batch-limit" : "step-limit",
    );
    expect(events).toEqual(["prepare:1", "request:1", "save"]);
  },
);

it("lets a corrected response follow invalid tool feedback", async () => {
  const { operations, events } = fixture([toolResponse, finalResponse]);
  operations.executeTools = async () => "invalid";

  expect(await runModelLoop(operations)).toBe("completed");
  expect(events).toEqual([
    "prepare:1",
    "request:1",
    "save",
    "prepare:2",
    "request:1",
    "save",
    "complete",
  ]);
});

it("saves an empty response before reporting the existing protocol error", async () => {
  const { operations, events } = fixture([{ text: "", output: [] }]);

  await expect(runModelLoop(operations)).rejects.toThrow(
    "模型未返回文本或工具调用",
  );
  expect(events).toEqual(["prepare:1", "request:1", "save"]);
});
