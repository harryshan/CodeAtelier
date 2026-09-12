/**
 * 文件作用：验证辅助模型配置及生产引擎的摘要路由。
 * 协作：使用临时 Config/Store 与受控模型替身，不访问真实模型或个人项目。
 * 结构：先检查默认值、环境与持久化、非法输入；再驱动长历史摘要及失败路径。
 * 边界：检查主任务与摘要使用不同模型和预算，失败保留原始历史；不执行 Evaluation。
 */
import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { auxiliarySettings } from "../src/config/auxiliary-model.js";
import { Engine } from "../src/agent/engine.js";
import { Store } from "../src/sessions/store.js";
import { createBudget } from "../src/context/token-budget.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => vi.unstubAllEnvs());

it("inherits the main model and effort for old settings and validates auxiliary values", async () => {
  vi.stubEnv("CODEATELIER_AUXILIARY_MODEL", "");
  const config = new Config(await temp());
  expect(config.settings.auxiliaryModel).toBe("");
  expect(auxiliarySettings(config.settings).model).toBe(config.settings.model);
  expect(auxiliarySettings(config.settings).reasoningEffort).toBe(
    config.settings.reasoningEffort,
  );
  expect(() =>
    config.update({
      settings: { ...config.settings, auxiliaryModel: "x".repeat(201) },
    }),
  ).toThrow();
  expect(() =>
    config.update({
      settings: { ...config.settings, auxiliaryReasoningEffort: "invalid" },
    }),
  ).toThrow();
});

it("loads environment defaults and persists an explicit override and clearing", async () => {
  vi.stubEnv("CODEATELIER_AUXILIARY_MODEL", "env-small");
  vi.stubEnv("CODEATELIER_AUXILIARY_REASONING_EFFORT", "medium");
  const config = new Config(await temp());
  expect(auxiliarySettings(config.settings)).toMatchObject({
    model: "env-small",
    reasoningEffort: "medium",
  });
  config.update({
    settings: {
      ...config.settings,
      auxiliaryModel: " small ",
      auxiliaryReasoningEffort: "low",
    },
  });
  const reopened = new Config(config.directory);
  expect(auxiliarySettings(reopened.settings)).toMatchObject({
    model: "small",
    reasoningEffort: "low",
    baseUrl: config.settings.baseUrl,
  });
  expect(reopened.settings.model).toBe(config.settings.model);
  reopened.update({ settings: { ...reopened.settings, auxiliaryModel: " " } });
  expect(new Config(config.directory).settings.auxiliaryModel).toBe("");
});

it.each([false, true])(
  "routes compaction independently and preserves history on failure=%s",
  async (fail) => {
    const config = new Config(await temp());
    config.settings.auxiliaryModel = "small";
    config.settings.auxiliaryReasoningEffort = "low";
    config.settings.contextChars = 20000;
    const store = new Store(path.join(config.directory, "test.db"));
    const session = store.create(await temp(), "test");
    const source = [
      { role: "user", content: "Keep the public API" },
      { role: "assistant", content: "historical analysis ".repeat(1600) },
      { role: "user", content: "Continue carefully" },
    ];
    store.saveContext(session.id, source);
    const chunks: any[] = [];
    const models: string[] = [];
    let mainCalls = 0;
    const engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      (settings, purpose) => {
        models.push(settings.model);
        if (purpose === "task") {
          expect(settings.model).toBe(config.settings.model);

          return {
            async run() {
              mainCalls++;

              return { output: [], text: "done" };
            },
          };
        }

        expect(settings.reasoningEffort).toBe("low");

        return {
          async getCapabilities() {
            return {
              tokenizer: "o200k_base",
              limits: {
                max_context_window_tokens: 10000,
                max_output_tokens: 1000,
              },
            };
          },
          async run(input, instructions, tools, _signal, _delta, options) {
            expect(tools).toEqual([]);
            expect(options?.maxOutputTokens).toBe(1000);
            const budget = createBudget(
              {
                tokenizer: "o200k_base",
                limits: {
                  max_context_window_tokens: 10000,
                  max_output_tokens: 1000,
                },
              },
              20000,
            );
            expect(
              budget.measure(input, instructions, tools),
            ).toBeLessThanOrEqual(budget.limit * 0.7);
            chunks.push(...JSON.parse(input[0].content));
            if (fail) {
              return { output: [], text: "invalid JSON" };
            }

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
        };
      },
    );
    try {
      const task = engine.start(session.id, "Continue");
      await engine.active!.done;
      expect(models).toEqual([config.settings.model, "small"]);
      expect(chunks.length).toBeGreaterThan(0);
      if (fail) {
        expect(mainCalls).toBe(0);
        expect(store.task(task.id)?.status).toBe("failed");
        expect(store.latestContextSnapshot(session.id)).toBeUndefined();
        expect(store.context(session.id)).toEqual([
          ...source,
          { role: "user", content: "Continue" },
        ]);
      } else {
        expect(mainCalls).toBe(1);
        expect(store.task(task.id)?.status).toBe("completed");
        const snapshot = store.latestContextSnapshot(session.id)!;
        expect(snapshot.model).toBe("small");
        expect(snapshot.source).toEqual(expect.arrayContaining(source));
        expect(
          chunks
            .filter((record) => record.index === 1)
            .map((record) => record.excerpt)
            .join(""),
        ).toBe(JSON.stringify(source[1]));
      }
    } finally {
      await engine.close();
      store.close();
    }
  },
);
