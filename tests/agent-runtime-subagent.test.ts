/*
 * 使用真实子进程 Runtime、双向 IPC、宿主 Engine/SQLite 和模拟模型验证可选子任务的第二执行路径。
 *
 * 1. 在对外功能门禁仍关闭时，内部创建带开关的任务，通过注入的 stdio launcher 运行真实 Runtime loop。
 * 2. 主 loop 规划/等待/收集，子 Worker 只见三个受限读取工具，Broker 按任务身份登记并分配全局租约。
 * 3. 核对计划/状态落盘后及时通知 SSE 刷新、报告/主反馈同分片、线程清理、tracing 和源码未变；stdio 夹具不是专用账户验收。
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { Config } from "../src/config/config.js";
import { Engine } from "../src/agent/engine.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type { AgentRuntimeLauncher } from "../src/sandbox/agent-runtime-launcher.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

const request = (nodeId: string, action: unknown) =>
  JSON.stringify({
    execution: { id: nodeId, dependsOn: [] },
    arguments: { request: action },
  });

it("coordinates subagent Workers inside the Runtime through task-bound Broker IPC", async () => {
  const root = await temp();
  await mkdir(path.join(root, "src"));
  const source = path.join(root, "src", "evidence.ts");
  await writeFile(source, "export const evidence = 42;\n");
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
  const session = store.create(root, "research task");
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
        close: async () => {
          const exit = new Promise<"clean" | "orphaned">((resolve) => {
            if (child.exitCode !== null) {
              resolve(child.exitCode === 0 ? "clean" : "orphaned");

              return;
            }

            child.once("exit", (code) =>
              resolve(code === 0 ? "clean" : "orphaned"),
            );
          });
          child.stdin.end();

          return exit;
        },
      };
    },
  };
  let mainCalls = 0;
  let childCalls = 0;
  const provider: ModelProvider = {
    async getCapabilities() {
      return {
        limits: { max_context_window_tokens: 64_000, max_output_tokens: 2_048 },
      };
    },
    async run(input, instructions, tools) {
      if (instructions.includes("read-only research subagent")) {
        childCalls++;
        expect(tools.map((tool) => tool.name)).toEqual([
          "read_file",
          "list_entries",
          "search_text",
        ]);
        if (childCalls === 1) {
          return {
            text: "",
            output: [
              {
                type: "function_call",
                call_id: "read",
                name: "read_file",
                arguments: JSON.stringify({
                  execution: { id: "read", dependsOn: [] },
                  arguments: {
                    path: "src/evidence.ts",
                    startLine: 1,
                    endLine: 1,
                  },
                }),
              },
            ],
          };
        }

        expect(JSON.stringify(input)).toContain("evidence = 42");

        return { text: "src/evidence.ts:1 evidence is 42", output: [] };
      }

      mainCalls++;
      expect(tools.some((tool) => tool.name === "subagent")).toBe(true);
      if (mainCalls === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "plan",
              name: "subagent",
              arguments: request("plan", {
                action: "plan",
                subtasks: [
                  {
                    id: "review",
                    role: "reader",
                    objective: "inspect evidence",
                    scope: ["src"],
                    dependsOn: [],
                    deliverable: "cite source",
                  },
                ],
              }),
            },
          ],
        };
      }

      if (mainCalls === 2) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "wait",
              name: "subagent",
              arguments: request("wait", {
                action: "await",
                subagentIds: ["review"],
                timeoutMs: 15_000,
              }),
            },
          ],
        };
      }

      if (mainCalls === 3) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "collect",
              name: "subagent",
              arguments: request("collect", {
                action: "collect",
                subagentIds: ["review"],
              }),
            },
          ],
        };
      }

      expect(JSON.stringify(input)).toContain("evidence is 42");

      return { text: "Research collected", output: [] };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
    launcher,
  );
  const refreshedSubagentStates: string[] = [];
  engine.events.on("change", (sessionId) => {
    if (sessionId !== session.id) {
      return;
    }

    const latest = store.events(session.id).at(-1);

    if (latest?.type === "subagent_state") {
      refreshedSubagentStates.push(latest.data.status);
    }
  });

  try {
    const task = store.transaction(() => {
      const created = store.createTask(session.id, true);
      store.event(session.id, created.id, "user", { text: "inspect evidence" });

      return created;
    });
    (engine as unknown as { schedule(): void }).schedule();
    await engine.active?.done;

    expect(store.task(task.id)?.status).toBe("completed");
    expect(store.subagents(task.id)).toMatchObject([
      {
        id: "review",
        status: "completed",
        consumed: true,
        report: "src/evidence.ts:1 evidence is 42",
      },
    ]);
    expect(
      store
        .context(session.id)
        .some(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "collect" &&
            item.output.includes("evidence is 42"),
        ),
    ).toBe(true);
    expect(mainCalls).toBe(4);
    expect(childCalls).toBe(2);
    expect(refreshedSubagentStates).toContain("running");
    expect(refreshedSubagentStates).toContain("completed");
    expect(await readFile(source, "utf8")).toBe(
      "export const evidence = 42;\n",
    );
    expect(Buffer.concat(errors).toString("utf8")).toBe("");
    const trace = await engine.savedTrace(task);
    expect(trace).toContain("subagent.worker");
    expect(trace).not.toContain("evidence is 42");
  } finally {
    await engine.close();
    store.close();
  }
});
