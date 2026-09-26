/**
 * 检查模型容量、token 估算和实际 usage 如何传到预算管理与任务记录中。
 * 使用固定元数据、真实 tokenizer、模拟模型和临时 Store。
 *
 * 1. 检查手动窗口覆盖、输出预留、安全余量、未知编码回退，以及中文、代码和特殊字面量的计数。
 * 2. 检查 usage 校验拒绝非法数值，保留支持的明细。
 * 3. 在 ContextManager 中区分 token 预算和按字符记录的归档信息。
 * 4. 在 Engine 中核对输出限制参数、实际模型请求/usage 保存和容量查询失败后的回退。
 * 5. 检查重复计量、实报双向校准与追加增量、配置/前缀变化、非法用量和 Worker 压缩后的基线重建。
 *
 * 缺少容量或用量时应使用对应的回退逻辑，不能编造零值。
 */

import { expect, it, vi } from "vitest";
import { Tiktoken } from "js-tiktoken/lite";
import { createBudget, measureContext } from "../src/context/token-budget.js";
import {
  parseUsage,
  capabilitiesSchema,
} from "../src/providers/model-metadata.js";
import { ContextManager } from "../src/context/context-manager.js";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import path from "node:path";
import pino from "pino";
import { temp } from "./fixtures/helpers.js";

const capabilities = {
  tokenizer: "o200k_base",
  limits: {
    max_context_window_tokens: 372000,
    max_output_tokens: 128000,
    max_prompt_tokens: 372000,
  },
};

it("derives token capacity from metadata and reserves the actual output cap", () => {
  const budget = createBudget(capabilities, 180000);
  expect(budget).toMatchObject({
    unit: "tokens",
    outputTokens: 16384,
    safetyTokens: 18600,
    limit: 337016,
  });
  const limited = createBudget(
    {
      ...capabilities,
      limits: {
        ...capabilities.limits,
        max_output_tokens: 1000,
        max_prompt_tokens: 100000,
      },
    },
    180000,
  );
  expect(limited.outputTokens).toBe(1000);
  expect(limited.limit).toBe(81400);
  const overridden = createBudget(
    {
      ...capabilities,
      limits: {
        ...capabilities.limits,
        max_context_window_tokens: 100_000,
        max_prompt_tokens: 90_000,
      },
    },
    180_000,
    16_384,
    300_000,
  );
  expect(overridden).toMatchObject({
    contextWindowTokens: 300_000,
    safetyTokens: 15_000,
    outputTokens: 16_384,
    limit: 268_616,
  });
  expect(createBudget(capabilities, 180_000, 16_384, 50_000).limit).toBe(
    31_116,
  );
  expect(createBudget(undefined, 12345, 16384, 300000).limit).toBe(12345);
  expect(
    createBudget({ ...capabilities, tokenizer: "unknown" }, 12345).limit,
  ).toBe(12345);
});

it("tokenizes Chinese, code, tools and special token literals without treating them as control tokens", () => {
  const budget = createBudget(capabilities, 180000);
  const input = [
    {
      role: "user",
      content: "解释函数 const add = (a,b) => a+b; <|endoftext|>",
    },
  ];
  const amount = budget.measure(input, "规则", []);
  expect(amount).toBeGreaterThan(0);
  expect(amount).toBeLessThan(JSON.stringify(input).length);
  expect(
    budget.measure(input, "规则", [
      { name: "read_file", description: "读取文件" },
    ]),
  ).toBeGreaterThan(amount);
});

it("reuses tokenized history across prepare, request and usage, only encoding appended records", () => {
  const encode = vi.spyOn(Tiktoken.prototype, "encode");
  try {
    const budget = createBudget(capabilities, 180000);
    const input = [{ role: "user", content: "first" }];
    const initial = budget.measure(input, "rules", []);
    const firstCalls = encode.mock.calls.length;

    expect(budget.measure(input, "rules", [])).toBe(initial);
    budget.observeUsage!(initial * 2, input, "rules", []);
    expect(budget.measure(input, "rules", [])).toBe(initial * 2);
    expect(encode).toHaveBeenCalledTimes(firstCalls);

    input.push({ role: "assistant", content: "second" });
    const appended = budget.measure(input, "rules", []);
    expect(encode).toHaveBeenCalledTimes(firstCalls + 1);
    expect(appended).toBeGreaterThan(initial * 2);
    expect(budget.measure(input, "rules", [])).toBe(appended);
    expect(encode).toHaveBeenCalledTimes(firstCalls + 1);

    input[1] = { role: "assistant", content: "replaced with more text" };
    expect(budget.measure(input, "rules", [])).toBe(
      measureContext(budget.measurement, input, "rules", []),
    );
    expect(budget.measure(input, "new rules", [])).toBe(
      measureContext(budget.measurement, input, "new rules", []),
    );
    expect(encode.mock.calls.length).toBeGreaterThan(firstCalls + 4);

    const tools = [{ name: "read_file", description: "读取文件" }];
    expect(budget.measure(input, "new rules", tools)).toBe(
      measureContext(budget.measurement, input, "new rules", tools),
    );
    const changedArray = [...input, { role: "user", content: "third" }];
    expect(budget.measure(changedArray, "new rules", tools)).toBe(
      measureContext(budget.measurement, changedArray, "new rules", tools),
    );
  } finally {
    encode.mockRestore();
  }
});

it("validates usage, retains numeric details, and drops arbitrary attribution", () => {
  expect(
    parseUsage({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      attribution: { private: "secret" },
      input_tokens_details: { cached_tokens: 3 },
    }),
  ).toEqual({
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 3 },
  });
  for (const input of [
    null,
    {},
    { input_tokens: -1, output_tokens: 1, total_tokens: 0 },
    { input_tokens: 10, output_tokens: 5, total_tokens: 100 },
    {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      output_tokens_details: { reasoning_tokens: 6 },
    },
  ]) {
    expect(parseUsage(input)).toBeUndefined();
  }

  expect(
    capabilitiesSchema.safeParse({
      tokenizer: "o200k_base",
      limits: { max_context_window_tokens: -1 },
    }).success,
  ).toBe(false);
});

it("uses token measurement through compaction and keeps character archive metadata accurate", async () => {
  const store = new Store(path.join(await temp(), "db"));
  const session = store.create(await temp(), "token context");
  const budget = createBudget(
    {
      ...capabilities,
      limits: { max_context_window_tokens: 12000, max_output_tokens: 1000 },
    },
    180000,
  );
  let observedOutput = 0;
  const reset = vi.fn(() => budget.resetMeasurement?.());
  const manager = new ContextManager({
    store,
    sessionId: session.id,
    model: "test",
    limit: budget.limit,
    measure: budget.measure,
    resetMeasurement: reset,
    measurement: budget.measurement,
    unit: budget.unit,
    maxOutputTokens: budget.outputTokens,
    signal: new AbortController().signal,
    clean: (text) => text,
    notice: () => {},
    report: () => {},
    provider: {
      async run(_input, _instructions, _tools, _signal, _delta, options) {
        observedOutput = options?.maxOutputTokens ?? 0;

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
  });
  try {
    const source = [
      { role: "user", content: "修复" },
      { role: "assistant", content: "读取 const x = 123;\n".repeat(2200) },
      { role: "user", content: "继续" },
    ];
    // A low real input count prevents premature compaction even when local JSON counting is large.
    budget.observeUsage!(1000, source, "rules", []);
    expect(await manager.prepare(source, "rules", [])).toBe(source);
    expect(reset).not.toHaveBeenCalled();

    budget.observeUsage!(9000, source, "rules", []);
    const next = await manager.prepare(source, "rules", []);
    expect(reset).toHaveBeenCalledTimes(1);
    const snapshot = store.latestContextSnapshot(session.id)!;
    expect(snapshot.budget?.unit).toBe("tokens");
    expect(snapshot.budget!.before).toBe(9000);
    expect(snapshot.budget!.after).toBeLessThanOrEqual(budget.limit * 0.6);
    expect(snapshot.beforeChars).toBeGreaterThan(snapshot.budget!.before);
    expect(next.at(-1)).toEqual(source.at(-1));
    expect(observedOutput).toBe(budget.outputTokens);

    const encode = vi.spyOn(Tiktoken.prototype, "encode");
    try {
      expect(budget.measure(next, "rules", [])).toBe(snapshot.budget!.after);
      const freshCalls = encode.mock.calls.length;
      expect(freshCalls).toBeGreaterThan(0);
      expect(budget.measure(next, "rules", [])).toBe(snapshot.budget!.after);
      expect(encode).toHaveBeenCalledTimes(freshCalls);
    } finally {
      encode.mockRestore();
    }
  } finally {
    store.close();
  }
});

it("persists service usage and exposes the discovered capacity while sending the reserved output limit", async () => {
  const config = new Config(await temp());
  const file = path.join(await temp(), "db");
  const store = new Store(file);
  const session = store.create(await temp(), "usage");
  let sentLimit = 0;
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async getCapabilities() {
      return capabilities;
    },
    async run(_input, _instructions, _tools, _signal, _delta, options) {
      sentLimit = options?.maxOutputTokens ?? 0;

      return {
        output: [{ role: "assistant", content: "OK" }],
        text: "OK",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
    },
  }));
  try {
    engine.start(session.id, "hello");
    await engine.active?.done;
    expect(store.tasks(session.id)[0].status).toBe("completed");
    expect(sentLimit).toBe(16384);
    expect(
      store.events(session.id).find((event) => event.type === "context_budget")
        ?.data,
    ).toMatchObject({
      unit: "tokens",
      contextWindowTokens: 372000,
      effectiveWindowTokens: 300000,
      inputLimit: 268616,
    });
    expect(
      store.events(session.id).find((event) => event.type === "model_request")
        ?.data,
    ).toMatchObject({ purpose: "task", step: 1, attempt: 1 });
    expect(
      store.events(session.id).find((event) => event.type === "model_usage")
        ?.data,
    ).toMatchObject({ input_tokens: 10, output_tokens: 5, purpose: "task" });
  } finally {
    await engine.close();
    store.close();
  }

  const reopened = new Store(file);
  try {
    expect(
      reopened.events(session.id).some((event) => event.type === "model_usage"),
    ).toBe(true);
  } finally {
    reopened.close();
  }
});

it("metadata failure falls back without blocking the task", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(await temp(), "db"));
  const session = store.create(await temp(), "fallback");
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async getCapabilities() {
      throw new Error("unavailable");
    },
    async run() {
      return { output: [{ role: "assistant", content: "ok" }], text: "ok" };
    },
  }));
  try {
    engine.start(session.id, "hello");
    await engine.active?.done;
    expect(store.tasks(session.id)[0].status).toBe("completed");
    expect(
      store.events(session.id).find((event) => event.type === "context_budget")
        ?.data.unit,
    ).toBe("characters");
    expect(
      store.events(session.id).find((event) => event.type === "model_request")
        ?.data,
    ).toMatchObject({ purpose: "task", step: 1, attempt: 1 });
    expect(
      store.events(session.id).filter((event) => event.type === "model_usage"),
    ).toEqual([]);
  } finally {
    await engine.close();
    store.close();
  }
});

it("anchors input to the latest service usage in both directions and estimates only appended items", () => {
  const budget = createBudget(capabilities, 180000);
  const input = [{ role: "user", content: "hello" }];
  const initial = budget.measure(input, "", []);
  budget.observeUsage!(initial * 2, input, "", []);
  expect(budget.measure(input, "", [])).toBe(initial * 2);
  budget.observeUsage!(5, input, "", []);
  expect(budget.measure(input, "", [])).toBe(5);

  input.push({ role: "assistant", content: "new answer" });
  const local = measureContext(budget.measurement, input, "", []);
  expect(budget.measure(input, "", [])).toBe(5 + local - initial);
  budget.observeUsage!(12, input, "", []);
  expect(budget.measure(input, "", [])).toBe(12);

  // Rewritten candidates in the Worker use local counts, not the old request's usage.
  expect(
    measureContext(structuredClone(budget.measurement), input, "", []),
  ).toBe(local);
  budget.resetMeasurement!();
  expect(budget.measure(input, "", [])).toBe(local);
  expect(createBudget(capabilities, 180000).measure(input, "", [])).toBe(local);
});

it("invalidates usage anchors when history or request configuration changes", () => {
  for (const change of [
    "array",
    "prefix",
    "truncate",
    "instructions",
    "tools",
  ]) {
    const budget = createBudget(capabilities, 180000);
    let input = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    let instructions = "rules";
    let tools: any[] = [];
    budget.observeUsage!(10000, input, instructions, tools);
    if (change === "array") {
      input = [...input];
    } else if (change === "prefix") {
      input[0] = { role: "user", content: "changed" };
    } else if (change === "truncate") {
      input.pop();
    } else if (change === "instructions") {
      instructions = "new rules";
    } else {
      tools = [{ name: "read_file" }];
    }

    expect(budget.measure(input, instructions, tools)).toBe(
      createBudget(capabilities, 180000).measure(input, instructions, tools),
    );
  }
});

it("ignores invalid usage without losing the last valid baseline", () => {
  const budget = createBudget(capabilities, 180000);
  const input = [{ role: "user", content: "hello" }];
  budget.observeUsage!(10, input, "", []);
  for (const invalid of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    budget.observeUsage!(invalid, input, "", []);
    expect(budget.measure(input, "", [])).toBe(10);
  }

  budget.observeUsage!(0, input, "", []);
  expect(budget.measure(input, "", [])).toBe(0);
});
