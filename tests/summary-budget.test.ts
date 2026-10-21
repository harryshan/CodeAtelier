/**
 * 检查宿主和独立 Node Runtime 的摘要请求不受主上下文手动窗口约束。
 * 1. launcher 仅提供应用层 stdio IPC，不声明 Windows 安装态隔离验证。
 * 2. 以有/无辅助模型两种配置压缩超过主预算的历史，服务容量足以一次摘要。
 * 3. 检查实际摘要输入、输出预留、完整原文与最终主预算验收，以及容量查询失败的字符回退；模型完全模拟，无网络访问。
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
])(
  "uses service summary capacity with runtime=%s auxiliary=%s metadataFailure=%s",
  async (runtime, auxiliary, metadataFailure) => {
    const config = new Config(await temp());
    config.sandbox.enabled = runtime;
    config.settings.maxContextTokens = 50000;
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
            if (metadataFailure && settings.model === "summary-model") {
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
                1000000,
                1000,
              );
              const manual = createBudget(capabilities, 1000000, 1000, 50000);
              const amount = service.measure(input, instructions, tools);
              expect(amount).toBeGreaterThan(manual.limit * 0.7);
              expect(amount).toBeLessThanOrEqual(service.limit * 0.7);
              expect(options?.maxOutputTokens).toBe(
                metadataFailure ? undefined : 1000,
              );
              expect(
                JSON.parse(input[0].content).some(
                  (record: any) =>
                    record.excerpt ===
                    JSON.stringify({ role: "assistant", content: history }),
                ),
              ).toBe(true);

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
            const budget = createBudget(capabilities, 1000000, 1000, 50000);
            expect(
              budget.measure(input, instructions, tools),
            ).toBeLessThanOrEqual(budget.limit * 0.6);

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
      expect(summaries).toBe(1);
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
