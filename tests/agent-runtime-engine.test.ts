/**
 * 验证 Engine 在显式注入已认证 AgentRuntimeLauncher 后，把完整 agent loop 切换到独立 Runtime 进程。
 * 测试 launcher 只用 stdio 和环境变量传递测试身份，不提供 Windows token/Job/ACL 证明，不是产品 Sandbox 验收。
 *
 * 1. Engine 生成 instance/nonce，launcher 启动真实 Node 子进程并返回 IPC 流。
 * 2. 子进程运行 read_file 工具 DAG 并检查工具内阶段及任务结束清理 trace，Broker 仅提供模型、session、审批和记忆 adapter；固定白名单细分 trace 不包含文件内容。
 * 3. Engine 等待 Runtime 终态与 clean 退出，再把任务和 execution instance 记为 completed。
 * 4. 扩展权限命令经低成本模型审批后，把规范化根和 host 交给独立 capability runner，并将结果送回 agent loop。
 * 5. Runtime IPC 在可信终态前断开时，Engine 以 unknown 关闭 launcher 并持久化可能副作用。
 * 6. 已启动 Push Runner 的 clean cancellation 仍记录远端副作用可能已经发生。
 * 7. launcher 证明 Runtime 尚未启动且 provision 已回滚时，Engine 明确记录 host fallback 并继续宿主 loop。
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
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
    async run(input, instructions, tools) {
      modelCalls += 1;
      expect(tools).toContainEqual({ type: "web_search" });
      expect(tools.map((tool: any) => tool.name)).toContain(
        "run_with_permissions",
      );
      expect(instructions).toContain("Windows Agent Runtime");
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
    const chunks = store.db
      .prepare(
        "SELECT items FROM context_chunks WHERE sessionId=? ORDER BY position",
      )
      .all(session.id) as Array<{ items: string }>;
    expect(chunks.map((chunk) => JSON.parse(chunk.items).length)).toEqual([
      1, 1, 1,
    ]);
    expect(chunks.map((chunk) => JSON.parse(chunk.items)[0]?.type)).toEqual([
      undefined,
      "function_call",
      "function_call_output",
    ]);
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
      "read_file.stat",
      "read_file.bytes",
      "read_file.worker.queue",
      "read_file.worker.startup",
      "read_file.worker.response",
    ]) {
      const stage = trace.traceEvents.find(
        (event: any) => event.name === name && event.ph === "X",
      );
      expect(stage?.args).toMatchObject({
        callId: "runtime-read",
        status: "ok",
      });
      expect(JSON.stringify(stage)).not.toContain("from-runtime");
    }

    const toolSpan = trace.traceEvents.find(
      (event: any) => event.name === "tool.read_file" && event.ph === "X",
    );
    const runtimeStages = trace.traceEvents.filter(
      (event: any) =>
        event.name.startsWith("read_file.") &&
        event.name !== "read_file.pool.close" &&
        event.ph === "X",
    );
    expect(
      runtimeStages.every(
        (event: any) =>
          event.tid === toolSpan.tid &&
          event.ts >= toolSpan.ts &&
          event.ts + event.dur <= toolSpan.ts + toolSpan.dur,
      ),
    ).toBe(true);
    expect(runtimeStages.length).toBeGreaterThan(0);
    const shutdown = trace.traceEvents.filter(
      (event: any) => event.name === "read_file.pool.close",
    );
    expect(shutdown.map((event: any) => event.ph)).toEqual(["B", "E"]);
    expect(shutdown[0].args.status).toBe("ok");
    expect(shutdown[0].cat).toBe("read_file");
    expect(shutdown[0].tid).not.toBe(toolSpan.tid);
    expect(shutdown[0].ts).toBeGreaterThanOrEqual(toolSpan.ts + toolSpan.dur);
    expect(trace.traceEvents.map((event: any) => event.name)).not.toContain(
      "read_file.access",
    );
    expect(trace.traceEvents.map((event: any) => event.name)).not.toContain(
      "read_file.worker.compute",
    );

    for (const name of [
      "context.prepare",
      "context.prepare.measure_request_view",
      "context.request",
      "context.request.measure_input",
      "tool.result_persist",
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
              expect(input[0].content).toContain(
                JSON.stringify({ workspaceRoot: root }).slice(1, -1),
              );

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

    expect(store.task(task.id)?.status, store.task(task.id)?.error).toBe(
      "completed",
    );
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

it("records unknown when Runtime IPC closes before a trusted terminal result", async () => {
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
  const session = store.create(root, "runtime disconnect test");
  const close = vi.fn(async () => "clean" as const);
  const launcher: AgentRuntimeLauncher = {
    async launch() {
      const input = new PassThrough();
      const output = new PassThrough();
      input.end();

      return {
        input,
        output,
        pid: 52,
        close,
      };
    },
  };
  const provider: ModelProvider = {
    async run() {
      throw new Error("Broker model adapter must not run after disconnect.");
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
    const task = engine.start(session.id, "disconnect before result");
    await engine.active?.done;

    expect(store.task(task.id)?.status).toBe("failed");
    expect(close).toHaveBeenCalledWith("unknown");
    expect(
      store
        .events(session.id)
        .some(
          (event) =>
            event.type === "execution_instance" &&
            (event.data as any).kind === "agent-runtime" &&
            (event.data as any).state === "unknown" &&
            (event.data as any).sideEffectsPossible === true,
        ),
    ).toBe(true);
  } finally {
    await engine.close();
    store.close();
  }
});

it("records possible side effects when a started Push Runner is cancelled", async () => {
  const root = await temp();
  const config = new Config(await temp());
  config.sandbox.enabled = true;
  const store = new Store(path.join(config.directory, "db"));
  const session = store.create(root, "push cancellation test");
  const task = store.createTask(session.id);
  const controller = new AbortController();
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run() {
      return { text: "", output: [] };
    },
  }));
  const events: Array<{ type: string; data: any }> = [];
  vi.spyOn(engine.approvals, "request").mockResolvedValue(true);
  vi.spyOn(engine.sandbox, "statusFor").mockReturnValue({
    enabled: true,
    requested: true,
    applied: true,
    mode: "sandboxed",
    platform: process.platform,
    level: "test",
  });
  vi.spyOn(engine.sandbox, "executeCommand").mockImplementation(
    async (command) => {
      command.onProcessStarted(53, "runtime");
      controller.abort(new Error("cancel push"));
      throw controller.signal.reason;
    },
  );

  try {
    await expect(
      (engine as any).executeRuntimeGitPush(
        task,
        root,
        {
          remote: "origin",
          remoteUrl: "https://example.com/repository.git",
          host: "example.com",
          refspec: "HEAD:refs/heads/main",
          objectId: "a".repeat(40),
        },
        "push-call",
        controller.signal,
        config.settings,
        (type: string, data: any) => events.push({ type, data }),
      ),
    ).rejects.toThrow("cancel push");

    expect(events).toContainEqual({
      type: "execution_instance",
      data: expect.objectContaining({
        kind: "push-runner",
        state: "cancelled",
        sideEffectsPossible: true,
      }),
    });
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
    async run(_input, instructions, tools) {
      modelCalls += 1;

      expect(instructions).not.toContain("run_with_permissions");
      expect(instructions).not.toContain("Windows Agent Runtime");
      expect(tools.map((tool: any) => tool.name)).not.toContain(
        "run_with_permissions",
      );

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
        .some((event) => event.type === "sandbox_fallback"),
    ).toBe(true);
    expect(
      store
        .events(session.id)
        .some(
          (event) =>
            event.type === "sandbox_stage" &&
            (event.data as any).stage === "failed" &&
            (event.data as any).mode === "host-process-fallback",
        ),
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
