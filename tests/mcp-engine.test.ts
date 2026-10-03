/**
 * 验证 MCP 从主模型工具图经宿主或独立 Runtime 回到本机 Broker，并持久化结果与 trace。
 * 真实 Node Runtime 和 MCP stdio 夹具仅验证应用层连接，不证明 Windows 账户/Named Pipe 的安装态隔离。
 *
 * 1. runtimeLauncher 使用测试 stdio 身份夹具；close 等待子进程退出，不替代产品 transport。
 * 2. 两种模式使用同一脚本化模型完成发现、调用和失败后继阻断；审批由测试显式批准，不调用真实模型。
 * 3. 断言历史/replay 保留宿主执行归因、结果送回模型且凭据不泄露，MCP 内容和参数不进入 Perfetto。
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type { AgentRuntimeLauncher } from "../src/sandbox/agent-runtime-launcher.js";
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
      async run(input, _instructions, tools) {
        expect(
          tools.some((tool) => tool.name === "mcp" && tool.type === "function"),
        ).toBe(true);
        expect(tools.some((tool) => tool.type === "mcp")).toBe(false);
        expect(JSON.stringify(input)).not.toContain(
          "engine-private-secret-829",
        );
        calls += 1;
        if (calls === 1) {
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
    } finally {
      await engine.close();
      store.close();
    }
  },
);
