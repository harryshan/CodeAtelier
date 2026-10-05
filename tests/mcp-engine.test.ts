/**
 * 验证 MCP 从主模型工具图经宿主或独立 Runtime 回到本机 Broker，并持久化结果与 trace。
 * 真实 Node Runtime 和 MCP stdio 夹具仅验证应用层连接，不证明 Windows 账户/Named Pipe 的安装态隔离。
 *
 * 1. 无调用用例覆盖宿主/Runtime/启动前 fallback 的首次任务与续聊，目录展示不触发审批或 MCP 启动。
 * 2. runtimeLauncher 使用测试 stdio 身份夹具；close 等待子进程退出，不替代产品 transport。
 * 3. 两种模式在首次模型请求即看到公开目录，再用同一脚本化模型完成发现、调用和失败后继阻断；审批由测试显式批准，不调用真实模型。
 *    断言历史/replay 保留宿主执行归因、结果送回模型且凭据不泄露，MCP 摘要、内容和参数不进入 Perfetto。
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import {
  AgentRuntimeFallbackError,
  type AgentRuntimeLauncher,
} from "../src/sandbox/agent-runtime-launcher.js";
import { temp } from "./fixtures/helpers.js";

it.each(["host", "runtime", "fallback"])(
  "provides the MCP catalog without connecting on initial and continued tasks in %s mode",
  async (mode) => {
    const root = await temp();
    const directory = await temp();
    const marker = path.join(directory, "must-not-start");
    await writeFile(
      path.join(directory, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          notes: {
            description: "Search team notes",
            transport: "stdio",
            command: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
            ],
          },
          legacy: { transport: "stdio", command: "must-not-run" },
          hidden: {
            description: "Disabled private description",
            transport: "stdio",
            command: "must-not-run",
            enabled: false,
          },
        },
      }),
    );
    const config = new Config(directory);
    config.sandbox.enabled = mode !== "host";
    const store = new Store(path.join(directory, "db"));
    const session = store.create(root, "MCP catalog");
    let calls = 0;
    const provider: ModelProvider = {
      async run(_input, instructions) {
        expect(instructions).toContain('"name":"notes"');
        expect(instructions).toContain('"description":"Search team notes"');
        expect(instructions).toContain('"name":"legacy"');
        expect(instructions).toContain('"description":null');
        expect(instructions).not.toContain("Disabled private description");
        expect(instructions).not.toContain("must-not-run");
        expect(instructions).not.toContain("writeFileSync");
        calls += 1;

        return { text: "No external lookup needed", output: [] };
      },
    };
    const launcher =
      mode === "fallback"
        ? {
            async launch() {
              throw new AgentRuntimeFallbackError("catalog preflight fixture");
            },
          }
        : mode === "runtime"
          ? runtimeLauncher()
          : undefined;
    const engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      () => provider,
      launcher,
    );
    const approval = vi
      .spyOn(engine.approvals, "request")
      .mockResolvedValue(false);
    try {
      for (const prompt of ["Explain the available capabilities", "Continue"]) {
        const task = engine.start(session.id, prompt);
        await engine.active?.done;
        expect(store.task(task.id)?.status).toBe("completed");
        const trace = (await engine.savedTrace(task))!;
        expect(trace).not.toContain("mcp.connect");
        expect(trace).not.toContain("Search team notes");
      }

      expect(calls).toBe(2);
      expect(approval).not.toHaveBeenCalled();
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        store
          .events(session.id)
          .some((event) => event.type === "sandbox_fallback"),
      ).toBe(mode === "fallback");
    } finally {
      await engine.close();
      store.close();
    }
  },
);

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

it.each([false, true])(
  "executes MCP in the local backend with Runtime=%s and saves the real tool results",
  async (runtime) => {
    const root = await temp();
    const directory = await temp();
    await writeFile(
      path.join(directory, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            description: "Echo text and inspect fixture notes",
            transport: "stdio",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/mcp-server.ts")],
            env: { MCP_TEST_SECRET: "engine-private-secret-829" },
          },
        },
      }),
    );
    const config = new Config(directory);
    config.sandbox.enabled = runtime;
    const store = new Store(path.join(directory, "db"));
    const session = store.create(root, "MCP integration");
    let calls = 0;
    const call = (id: string, request: unknown, dependsOn: string[] = []) => ({
      type: "function_call" as const,
      call_id: id,
      name: "mcp",
      arguments: JSON.stringify({
        execution: { id, dependsOn },
        arguments: { request },
      }),
    });
    const provider: ModelProvider = {
      async getCapabilities() {
        return {
          limits: {
            max_context_window_tokens: 128000,
            max_output_tokens: 1024,
          },
        };
      },
      async run(input, instructions, tools) {
        expect(instructions).toContain("Available MCP servers");
        expect(instructions).toContain("Echo text and inspect fixture notes");
        expect(instructions).not.toContain("engine-private-secret-829");
        expect(instructions).not.toContain("mcp-server.ts");
        expect(
          tools.some((tool) => tool.name === "mcp" && tool.type === "function"),
        ).toBe(true);
        expect(tools.some((tool) => tool.type === "mcp")).toBe(false);
        expect(JSON.stringify(input)).not.toContain(
          "engine-private-secret-829",
        );
        calls += 1;
        if (calls === 1) {
          expect(approval).not.toHaveBeenCalled();

          return {
            text: "",
            output: [
              call("discover", {
                action: "list_tools",
                server: "local",
                cursor: null,
              }),
            ],
          };
        }

        if (calls === 2) {
          expect(JSON.stringify(input)).toContain("inputSchema");

          return {
            text: "",
            output: [
              call("echo", {
                action: "call_tool",
                server: "local",
                name: "echo",
                argumentsJson: '{"text":"mcp-private-payload-537"}',
              }),
            ],
          };
        }

        if (calls === 3) {
          expect(JSON.stringify(input)).toContain("broker-mcp");
          expect(JSON.stringify(input)).toContain("mcp-private-payload-537");

          return {
            text: "",
            output: [
              call("fail", {
                action: "call_tool",
                server: "local",
                name: "fail",
                argumentsJson: "{}",
              }),
              call(
                "blocked",
                { action: "list_resources", server: "local", cursor: null },
                ["fail"],
              ),
            ],
          };
        }

        return { text: "MCP done", output: [] };
      },
    };
    const engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      () => provider,
      runtime ? runtimeLauncher() : undefined,
    );
    const approval = vi
      .spyOn(engine.approvals, "request")
      .mockResolvedValue(true);
    try {
      const task = engine.start(session.id, "use the configured MCP fixture");
      await engine.active?.done;
      expect(store.task(task.id)?.status).toBe("completed");
      expect(calls).toBe(4);
      expect(approval).toHaveBeenCalledTimes(3);
      const replay = store.replayCase(task.id);
      const result = replay?.capture?.tools.find(
        (tool) => tool.callId === "echo",
      )?.result;
      expect(result).toMatchObject({
        execution: { kind: "broker-mcp", mode: "host-process" },
      });
      expect(JSON.stringify(result)).toContain("mcp-private-payload-537");
      expect(JSON.stringify(store.events(session.id))).not.toContain(
        "engine-private-secret-829",
      );
      const trace = (await engine.savedTrace(task))!;
      expect(trace).toContain("mcp.call_tool");
      expect(trace).toContain("mcp.close");
      expect(trace).not.toContain("mcp-private-payload-537");
      expect(trace).not.toContain("engine-private-secret-829");
      expect(trace).not.toContain("Echo text and inspect fixture notes");
    } finally {
      await engine.close();
      store.close();
    }
  },
);
