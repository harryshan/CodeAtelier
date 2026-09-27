/**
 * 验证 Engine 在显式注入已认证 AgentRuntimeLauncher 后，把完整 agent loop 切换到独立 Runtime 进程。
 * 测试 launcher 只用 stdio 和环境变量传递测试身份，不提供 Windows token/Job/ACL 证明，不是产品 Sandbox 验收。
 *
 * 1. Engine 生成 instance/nonce，launcher 启动真实 Node 子进程并返回 IPC 流。
 * 2. 子进程运行 read_file 工具 DAG 并检查工具内阶段及任务结束清理 trace，Broker 仅提供模型、session、审批和记忆 adapter；固定白名单细分 trace 不包含文件内容。
 * 3. Engine 等待 Runtime 终态与 clean 退出，再把任务和带有已验证进程身份的 execution instance 记为 completed。
 * 4. run_with_permissions 经低成本模型审批后由 Broker 宿主进程执行，单独记录 host-process，而不创建 Capability Runner。
 * 5. Runtime IPC 在可信终态前断开时，Engine 以 unknown 关闭 launcher 并持久化可能副作用。
 * 6. Broker 宿主 Git 先做固定预检、审批，再启动 push；已启动后取消仍记录远端副作用可能已经发生。
 * 7. launcher 证明 Runtime 尚未启动且 provision 已回滚时，Engine 明确记录 host fallback 并继续宿主 loop。
 */

import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
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

const runFile = promisify(execFile);

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
    const runtimeEvents = store
      .events(session.id)
      .filter((event) => event.type === "execution_instance")
      .map((event) => event.data as Record<string, unknown>);
    const runningRuntime = runtimeEvents.find(
      (event) => event.kind === "agent-runtime" && event.state === "running",
    );
    const completedRuntime = runtimeEvents.find(
      (event) => event.kind === "agent-runtime" && event.state === "completed",
    );
    expect(runningRuntime?.pid).toBeGreaterThan(0);
    expect(completedRuntime).toMatchObject({
      executionInstanceId: runningRuntime?.executionInstanceId,
      mode: "windows-sandbox-user",
      sandboxApplied: true,
      pid: runningRuntime?.pid,
      pidKind: "runtime",
    });
  } finally {
    await engine.close();
    store.close();
  }
});

for (const approve of [true, false]) {
  it(`reviews ${approve ? "approved" : "rejected"} Broker host command`, async () => {
    const root = await temp();
    const external = await temp();
    const marker = path.join(external, "broker-command-marker.txt");
    const quotedMarker = marker.replaceAll(
      "'",
      process.platform === "win32" ? "''" : "'\\''",
    );
    const command =
      process.platform === "win32"
        ? `Set-Content -LiteralPath '${quotedMarker}' -Value 'broker-result' -NoNewline; Write-Output 'broker-result'`
        : `printf 'broker-result' > '${quotedMarker}' && printf 'broker-result'`;
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
                    command,
                    reason: "需要在 Broker 宿主权限下写入工作区外的标记。",
                  },
                }),
              },
            ],
          };
        }

        expect(approve).toBe(true);
        expect(JSON.stringify(input)).toContain("broker-result");

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
                expect(JSON.stringify(input)).toContain("broker-host");
                expect(JSON.stringify(input)).toContain("宿主用户权限");
                expect(input[0].content).toContain(
                  JSON.stringify({ workspaceRoot: root }).slice(1, -1),
                );

                return {
                  text: JSON.stringify({
                    decision: approve ? "approve" : "reject",
                    reason: approve ? "权限声明明确" : "拒绝宿主命令",
                  }),
                  output: [],
                };
              },
            }
          : provider,
      launcher,
    );
    const execute = vi.spyOn(engine.sandbox, "executeCommand");

    try {
      const task = engine.start(session.id, "run external tool");
      await engine.active?.done;

      expect(store.task(task.id)?.status, store.task(task.id)?.error).toBe(
        approve ? "completed" : "failed",
      );
      expect(approvalCalls).toBe(1);
      expect(engine.approvals.list(session.id)).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      if (approve) {
        expect(await readFile(marker, "utf8")).toBe("broker-result");
      } else {
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      }

      expect(Buffer.concat(errors).toString("utf8")).toBe("");
      expect(
        store
          .events(session.id)
          .some(
            (event) =>
              event.type === "execution_instance" &&
              (event.data as any).kind === "broker-command" &&
              (event.data as any).mode === "host-process" &&
              (event.data as any).sandboxApplied === false &&
              (event.data as any).state === "completed" &&
              (event.data as any).pid > 0,
          ),
      ).toBe(approve);
      const trace = await engine.savedTrace(task);

      if (approve) {
        expect(trace).toContain("broker.command");
      } else {
        expect(trace).not.toContain("broker.command");
      }

      expect(trace).not.toContain(command);
    } finally {
      await engine.close();
      store.close();
    }
  });
}

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
            (event.data as any).pid === 52 &&
            (event.data as any).pidKind === "runtime" &&
            (event.data as any).sideEffectsPossible === true,
        ),
    ).toBe(true);
  } finally {
    await engine.close();
    store.close();
  }
});

it("keeps a cancelled Broker Git push out of the Sandbox Runner", async () => {
  const root = await temp();
  await runFile("git", ["init", "-b", "main"], { cwd: root });
  await runFile("git", ["config", "user.name", "Broker Test"], { cwd: root });
  await runFile("git", ["config", "user.email", "broker@example.test"], {
    cwd: root,
  });
  await writeFile(path.join(root, "tracked.txt"), "tracked\n");
  await runFile("git", ["add", "tracked.txt"], { cwd: root });
  await runFile(
    "git",
    ["-c", "commit.gpgSign=false", "commit", "--no-verify", "-m", "fixture"],
    {
      cwd: root,
    },
  );
  await runFile(
    "git",
    ["remote", "add", "origin", "https://127.0.0.1:1/verification.git"],
    {
      cwd: root,
    },
  );
  await runFile("git", ["config", "branch.main.remote", "origin"], {
    cwd: root,
  });
  await runFile("git", ["config", "branch.main.merge", "refs/heads/main"], {
    cwd: root,
  });
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
  const execute = vi.spyOn(engine.sandbox, "executeCommand");
  let approved = false;
  const emit = (type: string, data: any) => {
    events.push({ type, data });
    if (type === "notice") {
      approved = true;
    }

    if (
      approved &&
      type === "execution_instance" &&
      data.kind === "broker-git-push" &&
      data.state === "running"
    ) {
      controller.abort(new Error("cancel push"));
    }
  };

  try {
    await expect(
      (engine as any).executeBrokerGitPush(
        task,
        root,
        "push-call",
        controller.signal,
        config.settings,
        emit,
      ),
    ).rejects.toThrow("任务已取消");

    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "execution_instance",
      data: expect.objectContaining({
        kind: "broker-git-push",
        mode: "host-process",
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
