/**
 * 验证 Engine 在显式注入已认证 AgentRuntimeLauncher 后，把完整 agent loop 切换到独立 Runtime 进程。
 * 测试 launcher 只用 stdio 和环境变量传递测试身份，不提供 Windows token/Job/ACL 证明，不是产品 Sandbox 验收。
 *
 * 1. Engine 生成 instance/nonce，launcher 启动真实 Node 子进程并返回 IPC 流。
 * 2. 子进程运行 read_file 工具 DAG，Broker 仅提供模型、session、审批和记忆 adapter。
 * 3. Engine 等待 Runtime 终态与 clean 退出，再把任务和 execution instance 记为 completed。
 * 4. 扩展权限命令经低成本模型审批后，把规范化根和 host 交给独立 capability runner，并将结果送回 agent loop。
 * 5. launcher 证明 Runtime 尚未启动且 provision 已回滚时，Engine 明确记录 host fallback 并继续宿主 loop。
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type {
  AgentRuntimeLauncher,
  LaunchedAgentRuntime,
} from "../src/sandbox/agent-runtime-launcher.js";
import { AgentRuntimeFallbackError } from "../src/sandbox/agent-runtime-launcher.js";
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
    expect(store.replayCase(task.id)?.capture?.tools).toMatchObject([
      {
        callId: "runtime-read",
        name: "read_file",
        result: expect.objectContaining({
          text: expect.stringContaining("from-runtime"),
        }),
      },
    ]);
    const trace = JSON.parse((await engine.savedTrace(task))!);

    expect(
      trace.traceEvents.some((event: any) => event.name === "tool.read_file"),
    ).toBe(true);
    for (const name of [
      "context.prepare",
      "context.prepare.measure_request_view",
      "context.request",
      "context.request.measure_input",
    ]) {
      expect(
        trace.traceEvents.some(
          (event: any) => event.name === name && event.ph === "B",
        ),
      ).toBe(true);
      expect(
        trace.traceEvents.some(
          (event: any) => event.name === name && event.ph === "E",
        ),
      ).toBe(true);
    }

    expect(
      trace.traceEvents.some(
        (event: any) => event.args?.name === "Agent Runtime tools",
      ),
    ).toBe(true);
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

it("reviews and executes a capability command through the Broker", async () => {
  const root = await temp();
  const external = await temp();
  const config = new Config(await temp());
  config.sandbox.enabled = true;
  config.settings.auxiliaryModel = "approval-model";
  config.sandbox.initialStatus = {
    enabled: true,
    requested: true,
    applied: false,
    mode: "unknown",
    platform: process.platform,
    level: null,
  };
  const store = new Store(path.join(config.directory, "db"));
  const session = store.create(root, "capability test");
  const errors: Buffer[] = [];
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

      return {
        input: child.stdout,
        output: child.stdin,
        pid: child.pid!,
        close: async () =>
          new Promise<"clean" | "orphaned">((resolve) => {
            child.once("exit", (code) =>
              resolve(code === 0 ? "clean" : "orphaned"),
            );
            child.stdin.end();
          }),
      };
    },
  };
  let modelCalls = 0;
  let approvalCalls = 0;
  const provider: ModelProvider = {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 64_000,
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
              call_id: "capability-call",
              name: "run_with_permissions",
              arguments: JSON.stringify({
                execution: { id: "capability", dependsOn: [] },
                arguments: {
                  command: "external-tool --version",
                  permissions: {
                    readRoots: [external],
                    writeRoots: [],
                    httpsHost: "EXAMPLE.COM",
                  },
                  reason: "读取外部工具并访问其公开服务。",
                },
              }),
            },
          ],
        };
      }

      expect(JSON.stringify(input)).toContain("capability-result");

      return { text: "done", output: [] };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    (_settings, purpose) =>
      purpose === "approval"
        ? {
            async run(input) {
              approvalCalls += 1;
              expect(JSON.stringify(input)).toContain("example.com");

              return {
                text: '{"decision":"approve","reason":"权限声明明确"}',
                output: [],
              };
            },
          }
        : provider,
    launcher,
  );
  const sandboxedStatus = {
    enabled: true,
    requested: true,
    applied: true,
    mode: "sandboxed" as const,
    platform: "win32",
    level: "dedicated-user",
  };
  vi.spyOn(engine.sandbox, "statusFor").mockReturnValue(sandboxedStatus);
  const execute = vi
    .spyOn(engine.sandbox, "executeCommand")
    .mockImplementation(async (command) => {
      expect(command.kind).toBe("capability-runner");
      expect(command.toolCallId).toBe("capability-call");
      expect(command.readOnlyRoots).toEqual([path.resolve(external)]);
      expect(command.readWriteRoots).toEqual([]);
      expect(command.networkHost).toBe("example.com");
      command.onProcessStarted(4312, "runtime");
      command.onOutput?.("capability-result");

      return {
        result: {
          output: "capability-result",
          exitCode: 0,
          truncated: false,
        },
        status: sandboxedStatus,
      };
    });

  try {
    const task = engine.start(session.id, "run external tool");
    await engine.active?.done;

    expect(store.task(task.id)?.status).toBe("completed");
    expect(approvalCalls).toBe(1);
    expect(engine.approvals.list(session.id)).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
    expect(Buffer.concat(errors).toString("utf8")).toBe("");
    expect(
      store
        .events(session.id)
        .some(
          (event) =>
            event.type === "execution_instance" &&
            (event.data as any).kind === "capability-runner" &&
            (event.data as any).state === "completed",
        ),
    ).toBe(true);
    const trace = await engine.savedTrace(task);

    expect(trace).toContain("external-tool --version");
    expect(trace).toContain("EXAMPLE.COM");
  } finally {
    await engine.close();
    store.close();
  }
});

it("continues in the host loop only for an explicit pre-start Runtime fallback", async () => {
  const root = await temp();
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
  const session = store.create(root, "fallback test");
  const launcher: AgentRuntimeLauncher = {
    async launch() {
      throw new AgentRuntimeFallbackError("preflight failed");
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
    async run() {
      modelCalls += 1;

      return { text: "host fallback completed", output: [] };
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
    const task = engine.start(session.id, "continue safely");
    await engine.active?.done;

    expect(store.task(task.id)?.status).toBe("completed");
    expect(modelCalls).toBe(1);
    expect(
      store
        .events(session.id)
        .some((event) => event.type === "sandbox_warning"),
    ).toBe(true);
    expect(
      store
        .events(session.id)
        .some(
          (event) =>
            event.type === "execution_instance" &&
            (event.data as any).kind === "agent-runtime" &&
            (event.data as any).mode === "host-process" &&
            (event.data as any).sandboxApplied === false,
        ),
    ).toBe(true);
  } finally {
    await engine.close();
    store.close();
  }
});
