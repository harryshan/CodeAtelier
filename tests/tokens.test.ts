/**
 * 文件作用：验证模型容量、token 估算及实际 usage 的完整接入。
 * 代码结构：先定义服务能力样例，再覆盖预算和编码、usage 校验、压缩计量、持久化、能力查询降级和估算校准。
 */

import { expect, it } from "vitest";
import { createBudget } from "../src/context/token-budget.js";
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
  expect(createBudget(undefined, 12345).unit).toBe("characters");
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
  const manager = new ContextManager({
    store,
    sessionId: session.id,
    model: "test",
    limit: budget.limit,
    measure: budget.measure,
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
    const next = await manager.prepare(source, "rules", []);
    const snapshot = store.latestContextSnapshot(session.id)!;
    expect(snapshot.budget?.unit).toBe("tokens");
    expect(snapshot.budget!.after).toBeLessThanOrEqual(budget.limit * 0.6);
    expect(snapshot.beforeChars).toBeGreaterThan(snapshot.budget!.before);
    expect(next.at(-1)).toEqual(source.at(-1));
    expect(observedOutput).toBe(budget.outputTokens);
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
    ).toMatchObject({ unit: "tokens", contextWindowTokens: 372000 });
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
      store.events(session.id).filter((event) => event.type === "model_usage"),
    ).toEqual([]);
  } finally {
    await engine.close();
    store.close();
  }
});

it("calibrates underestimates from service usage without accumulating total consumption", () => {
  const budget = createBudget(capabilities, 180000);
  const input = [{ role: "user", content: "hello" }];
  const initial = budget.measure(input, "", []);
  budget.observeUsage!(initial * 2, input, "", []);
  expect(budget.measure(input, "", [])).toBe(initial * 2);
  budget.observeUsage!(initial, input, "", []);
  expect(budget.measure(input, "", [])).toBe(initial * 2);
  expect(createBudget(capabilities, 180000).measure(input, "", [])).toBe(
    initial,
  );
});
