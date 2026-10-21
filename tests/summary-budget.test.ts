/**
 * 检查宿主和独立 Node Runtime 的摘要请求不受主上下文手动窗口约束。
 * 1. launcher 仅提供应用层 stdio IPC，不声明 Windows 安装态隔离验证。
 * 2. 以有/无辅助模型两种配置压缩超过主预算的历史，服务容量足以一次摘要。
 * 3. 检查摘要输入按 tokenizer 计量、输出预留及完整原文；容量查询失败/缺失或 tokenizer 不受支持时才字符回退，并验证连续分块覆盖原文。模型完全模拟，无网络访问。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { Config } from "../src/config/config.js";
import { createBudget } from "../src/context/token-budget.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type { AgentRuntimeLauncher } from "../src/sandbox/agent-runtime-launcher.js";
import {
  TestEngine as Engine,
  TestStore as Store,
} from "./fixtures/managed-runtime.js";
import { createRuntimeChildClose } from "./fixtures/runtime-child-close.js";
import { temp } from "./fixtures/helpers.js";

const launcher: AgentRuntimeLauncher = {
  async launch(input) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("tests/fixtures/agent-runtime-service-child.ts"),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEATELIER_TEST_RUNTIME_DESCRIPTOR: JSON.stringify({
            identity: input.identity,
            nonce: input.nonce,
          }),
        },
      },
    );
    child.stderr.resume();

    return {
      input: child.stdout,
      output: child.stdin,
      pid: child.pid!,
      close: createRuntimeChildClose(child),
    };
  },
};

it.each([
  [false, false, false],
  [false, true, false],
  [true, false, false],
  [true, true, false],
  [false, true, true],
  [true, true, true],
  [false, true, "unsupported"],
  [true, true, "unsupported"],
  [false, false, "missing"],
  [true, false, "missing"],
] as const)(
  "uses service summary capacity with runtime=%s auxiliary=%s metadataFailure=%s",
  async (runtime, auxiliary, metadataFailure) => {
    const config = new Config(await temp());
    config.sandbox.enabled = runtime;
    config.settings.maxContextTokens = 50000;
    config.settings.contextChars = 120000;
    config.settings.maxOutputTokens = 1000;
    config.settings.auxiliaryModel = auxiliary ? "summary-model" : "";
    const store = new Store(path.join(config.directory, "db"));
    const session = store.create(await temp(), "summary capacity");
    const history = "historical analysis ".repeat(20000);
    store.saveContext(session.id, [
      { role: "user", content: "Preserve requirements" },
      { role: "assistant", content: history },
    ]);
    let summaries = 0;
    let mainCalls = 0;
    let archivedText = "";
    const engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      (settings) => {
        const capabilities = {
          tokenizer: "o200k_base",
          limits: {
            max_context_window_tokens:
              settings.model === "summary-model" ? 120000 : 200000,
            max_output_tokens: 1000,
          },
        };
        const provider: ModelProvider = {
          getCapabilities: async () => {
            if (
              metadataFailure &&
              (settings.model === "summary-model" || !auxiliary)
            ) {
              if (metadataFailure === "missing") {
                return undefined;
              }

              if (metadataFailure === "unsupported") {
                return { ...capabilities, tokenizer: "unsupported-tokenizer" };
              }

              throw new Error("metadata unavailable");
            }

            return capabilities;
          },
          async run(input, instructions, tools, _signal, _delta, options) {
            if (tools.length === 0) {
              summaries++;
              expect(settings.model).toBe(
                auxiliary ? "summary-model" : config.settings.model,
              );
              const service = createBudget(
                metadataFailure ? undefined : capabilities,
                config.settings.contextChars,
                1000,
              );
              const manual = createBudget(capabilities, 1000000, 1000, 50000);
              const amount = service.measure(input, instructions, tools);
              if (!metadataFailure) {
                expect(amount).toBeGreaterThan(manual.limit * 0.7);
              }

              expect(amount).toBeLessThanOrEqual(service.limit * 0.7);
              expect(service.unit).toBe(
                metadataFailure ? "characters" : "tokens",
              );
              expect(options?.maxOutputTokens).toBe(
                metadataFailure ? undefined : 1000,
              );
              for (const record of JSON.parse(input[0].content)) {
                expect(record.index).toBe(1);
                expect(record.offset).toBe(archivedText.length);
                expect(record.omitted).toBe(false);
                archivedText += record.excerpt;
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
            }

            mainCalls++;
            expect(input.some((item) => item.content === history)).toBe(false);

            return { output: [], text: "Done" };
          },
        };

        return provider;
      },
      runtime ? launcher : undefined,
    );
    try {
      const task = await engine.start(session.id, "Continue");
      await engine.active?.done;
      expect(store.task(task.id)?.status).toBe("completed");
      if (metadataFailure) {
        expect(summaries).toBeGreaterThan(1);
      } else {
        expect(summaries).toBe(1);
      }

      expect(archivedText).toBe(
        JSON.stringify({ role: "assistant", content: history }),
      );
      expect(
        store
          .events(session.id)
          .some(
            (event) =>
              event.type === "notice" &&
              String(event.data.text).includes("使用备用字符预算分块"),
          ),
      ).toBe(Boolean(metadataFailure));
      expect(mainCalls).toBe(1);
      expect(store.latestContextSnapshot(session.id)?.source).toContainEqual({
        role: "assistant",
        content: history,
      });
    } finally {
      await engine.close();
      await store.closeAsync();
    }
  },
);
