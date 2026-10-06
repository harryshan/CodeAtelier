/**
 * 验证同一会话的新任务在第一次压缩检查前恢复实报输入基线，而不是重新以完整 JSON 估算触发摘要。
 * 使用临时数据库、真实 tokenizer、脚本化模型及 Node stdio Runtime，不请求真实服务或安装专用账户。
 *
 * 1. runtimeLauncher 提供独立进程夹具，等待退出后释放管道；只验证应用层 IPC，不证明 OS 隔离。
 * 2. 宿主、Runtime、启动前 fallback 用相同历史完成三轮输入，第二轮收紧预算并改变项目指令。
 * 3. 第二轮无 usage，第三轮重建 Engine/Store 模拟重启；检查历史保留且未调用摘要模型。
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { Store } from "../src/sessions/store.js";
import {
  AgentRuntimeFallbackError,
  type AgentRuntimeLauncher,
} from "../src/sandbox/agent-runtime-launcher.js";
import { temp } from "./fixtures/helpers.js";

function runtimeLauncher(): AgentRuntimeLauncher {
  return {
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
      const exited = new Promise<"clean" | "orphaned">((resolve) => {
        child.once("exit", (code) =>
          resolve(code === 0 ? "clean" : "orphaned"),
        );
      });

      return {
        input: child.stdout,
        output: child.stdin,
        pid: child.pid!,
        close: async () => {
          child.stdin.end();
          const timer = setTimeout(() => child.kill(), 5000);
          try {
            return await exited;
          } finally {
            clearTimeout(timer);
          }
        },
      };
    },
  };
}

it.each(["host", "runtime", "fallback"])(
  "keeps calibrated history across new tasks and restart in %s mode",
  async (mode) => {
    const root = await temp();
    const directory = await temp();
    const database = path.join(directory, "db");
    const config = new Config(directory);
    config.sandbox.enabled = mode !== "host";
    config.update({
      settings: {
        ...config.settings,
        maxContextTokens: 100000,
        maxOutputTokens: 1000,
      },
    });
    let store = new Store(database);
    const session = store.create(root, "continuation");
    const history = "读取 const x = 123;\n".repeat(4500);
    store.saveContext(session.id, [
      { role: "user", content: "Inspect code" },
      { role: "assistant", content: history },
    ]);
    let calls = 0;
    let summaries = 0;
    const provider: ModelProvider = {
      async getCapabilities() {
        return {
          tokenizer: "o200k_base",
          limits: {
            max_context_window_tokens: 100000,
            max_output_tokens: 1000,
          },
        };
      },
      async run(input, _instructions, tools) {
        if (tools.length === 0) {
          summaries += 1;
          throw new Error("Unexpected compaction before continuation");
        }

        expect(input.some((item) => item.content === history)).toBe(true);
        calls += 1;

        return {
          text: "Done",
          output: [{ role: "assistant", content: "Done" }],
          usage:
            calls === 1
              ? { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 }
              : undefined,
        };
      },
    };
    const launcher =
      mode === "runtime"
        ? runtimeLauncher()
        : mode === "fallback"
          ? {
              async launch() {
                throw new AgentRuntimeFallbackError("preflight fixture");
              },
            }
          : undefined;
    const makeEngine = () =>
      new Engine(
        store,
        config,
        pino({ enabled: false }),
        () => provider,
        launcher,
      );
    let engine = makeEngine();
    try {
      const first = engine.start(session.id, "First turn");
      await engine.active?.done;
      expect(store.task(first.id)?.status).toBe("completed");
      const anchor = (await store.tokenAnchorAsync(session.id))!;
      expect(anchor.actualInputTokens).toBe(1000);
      expect(anchor.inputItems).toBe(3);
      const firstTrace = (await engine.savedTrace(first))!;
      expect(firstTrace).toContain("context.usage.save");
      expect(firstTrace).not.toContain(anchor.prefixHash);
      config.update({
        settings: { ...config.settings, maxContextTokens: 30000 },
      });
      await writeFile(
        path.join(root, "AGENTS.md"),
        "Explain verification results clearly.\n",
      );

      const second = engine.start(session.id, "Continue");
      await engine.active?.done;
      expect(store.task(second.id)?.status).toBe("completed");
      expect(summaries).toBe(0);
      expect(store.latestContextSnapshot(session.id)).toBeUndefined();

      await engine.close();
      await store.closeAsync();
      store = new Store(database);
      engine = makeEngine();
      const third = engine.start(session.id, "Continue after restart");
      await engine.active?.done;
      expect(store.task(third.id)?.status).toBe("completed");
      expect(await store.tokenAnchorAsync(session.id)).toEqual(anchor);
      const trace = (await engine.savedTrace(third))!;
      expect(trace).toContain("context.usage.restore");
      expect(trace).toMatch(/"restored"\s*:\s*true/);
      expect(trace).not.toContain(anchor.scope);
      expect(trace).not.toContain(anchor.prefixHash);
      expect(calls).toBe(3);
      expect(summaries).toBe(0);
      expect(store.latestContextSnapshot(session.id)).toBeUndefined();
      expect(
        store.context(session.id).filter((item) => item.role === "user"),
      ).toHaveLength(4);
    } finally {
      await engine.close();
      await store.closeAsync();
    }
  },
);
