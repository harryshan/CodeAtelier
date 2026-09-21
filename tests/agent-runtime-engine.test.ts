/**
 * 验证 Engine 在显式注入已认证 AgentRuntimeLauncher 后，把完整 agent loop 切换到独立 Runtime 进程。
 * 测试 launcher 只用 stdio 和环境变量传递测试身份，不提供 Windows token/Job/ACL 证明，不是产品 Sandbox 验收。
 *
 * 1. Engine 生成 instance/nonce，launcher 启动真实 Node 子进程并返回 IPC 流。
 * 2. 子进程运行 read_file 工具 DAG，Broker 仅提供模型、session、审批和记忆 adapter。
 * 3. Engine 等待 Runtime 终态与 clean 退出，再把任务和 execution instance 记为 completed。
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type {
  AgentRuntimeLauncher,
  LaunchedAgentRuntime,
} from "../src/sandbox/agent-runtime-launcher.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

it("moves the Engine agent loop into the launched Runtime process", async () => {
  const root = await temp();
  await writeFile(path.join(root, "runtime.txt"), "from-runtime\n");
  const config = new Config(await temp());
  config.sandbox.enabled = true;
  config.sandbox.initialStatus = {
    enabled: true,
    requested: true,
    applied: false,
    mode: "unknown",
    platform: process.platform,
    level: null,
  };
  const store = new Store(path.join(config.directory, "db"));
  const session = store.create(root, "runtime test");
  const errors: Buffer[] = [];
  let closeCalls = 0;
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
          cwd: process.cwd(),
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
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      let closed: Promise<"clean" | "orphaned"> | undefined;
      const launched: LaunchedAgentRuntime = {
        input: child.stdout,
        output: child.stdin,
        pid: child.pid!,
        close: async () => {
          closeCalls += 1;
          closed ??= new Promise((resolve) => {
            child.once("exit", (code) =>
              resolve(code === 0 ? "clean" : "orphaned"),
            );
            child.stdin.end();
          });

          return closed;
        },
      };

      return launched;
    },
  };
  let modelCalls = 0;
  const provider: ModelProvider = {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 32_000,
          max_output_tokens: 1_024,
        },
      };
    },
    async run(input) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "runtime-read",
              name: "read_file",
              arguments: JSON.stringify({
                execution: { id: "read", dependsOn: [] },
                arguments: { path: "runtime.txt", startLine: 1, endLine: 10 },
              }),
            },
          ],
        };
      }

      expect(JSON.stringify(input)).toContain("from-runtime");

      return { text: "done", output: [] };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
    launcher,
  );

  try {
    const task = engine.start(session.id, "read runtime.txt");
    await engine.active?.done;

    expect(store.task(task.id)?.status).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(closeCalls).toBe(1);
    expect(Buffer.concat(errors).toString("utf8")).toBe("");
    expect(
      store
        .events(session.id)
        .some(
          (event) =>
            event.type === "execution_instance" &&
            (event.data as any).kind === "agent-runtime" &&
            (event.data as any).state === "completed",
        ),
    ).toBe(true);
  } finally {
    await engine.close();
    store.close();
  }
});
