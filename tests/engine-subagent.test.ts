/*
 * 用生产 Engine、真实 SQLite 与 Worker 和模拟三协议模型验证可选 subagent 的宿主执行路径。
 *
 * 1. 独立于 UI/HTTP 回归，经内部排队记录分别启动 explorer/reviewer；主模型按 plan/await/collect 协调，reviewer 初始上下文必须包含明确变更材料。
 * 2. 两角色在三协议下仅看到只读函数与 Responses 专属内置搜索；搜索记录、带来源报告及主反馈共同持久化。
 * 3. 超过主任务工具输出预算的报告保留未消费状态，以便恢复后重新读取；原代码文件不得被子任务改写。
 * 4. 主任务与子任务的 Responses 缓存 key 各自稳定且不同，其他协议不生成；主任务续聊仍沿用会话 key。
 *
 * 此用例不验证 Sandbox/Runtime IPC、实际用户开关或 OS 级只读身份。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Store } from "../src/sessions/store.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { temp } from "./fixtures/helpers.js";

const scheduled = (id: string, request: unknown) =>
  JSON.stringify({
    execution: { id, dependsOn: [] },
    arguments: { request },
  });

it.each(
  (["responses", "chat-completions", "messages"] as const).flatMap((protocol) =>
    (["explorer", "reviewer"] as const).map((role) => ({ protocol, role })),
  ),
)(
  "coordinates $role with $protocol and commits collected feedback in the host Engine",
  async ({ role, protocol }) => {
    const root = await temp();
    await mkdir(path.join(root, "src"));
    const source = path.join(root, "src", "sample.ts");
    await writeFile(source, "export const value = 7;\n");
    const config = new Config(await temp());
    config.settings.protocol = protocol;
    const report =
      protocol === "responses"
        ? "sample.ts:1 value is 7; [source](https://example.com/reference)"
        : "sample.ts:1 value is 7";
    const searchOutput =
      protocol === "responses"
        ? [
            {
              type: "web_search_call",
              id: "search-1",
              status: "completed",
              action: { type: "search", query: "reference" },
            },
          ]
        : [];
    const store = new Store(path.join(config.directory, "history.sqlite"));
    const session = store.create(root, "test");
    let mainCalls = 0;
    let childCalls = 0;
    const mainKeys: Array<string | undefined> = [];
    const childKeys: Array<string | undefined> = [];
    const model: ModelProvider = {
      protocol,
      async run(input, instructions, tools, _signal, _onDelta, options) {
        if (instructions.includes("read-only research subagent")) {
          childKeys.push(options?.promptCacheKey);
          childCalls++;
          expect(
            tools
              .filter((tool) => tool.type === "function")
              .map((tool) => tool.name),
          ).toEqual(["read_file", "list_entries", "search_text", "ask_main"]);
          expect(tools.filter((tool) => tool.type !== "function")).toEqual(
            protocol === "responses" ? [{ type: "web_search" }] : [],
          );
          if (childCalls === 1) {
            expect(input).toHaveLength(1);
            if (role === "reviewer") {
              expect(String(input[0].content)).toContain(
                "src/sample.ts: baseline value = 6; current value = 7",
              );
            }

            return {
              output: [
                ...searchOutput,
                {
                  type: "function_call",
                  call_id: "read",
                  name: "read_file",
                  arguments: JSON.stringify({
                    execution: { id: "read", dependsOn: [] },
                    arguments: {
                      path: "src/sample.ts",
                      startLine: 1,
                      endLine: 1,
                    },
                  }),
                },
              ],
              text: "",
            };
          }

          expect(
            input.some((item) => item.type === "function_call_output"),
          ).toBe(true);

          for (const item of searchOutput) {
            expect(input).toContainEqual(item);
          }

          return { output: [], text: report };
        }

        mainCalls++;
        mainKeys.push(options?.promptCacheKey);
        expect(tools.some((tool) => tool.name === "subagent")).toBe(true);
        if (mainCalls === 1) {
          return {
            output: [
              {
                type: "function_call",
                call_id: "plan",
                name: "subagent",
                arguments: scheduled("plan", {
                  action: "plan",
                  subtasks: [
                    {
                      id: "review",
                      role,
                      ...(role === "reviewer"
                        ? {
                            changes:
                              "src/sample.ts: baseline value = 6; current value = 7",
                          }
                        : {}),
                      objective: "inspect",
                      scope: ["src"],
                      dependsOn: [],
                      deliverable: "evidence",
                    },
                  ],
                }),
              },
            ],
            text: "",
          };
        }

        if (mainCalls === 2) {
          return {
            output: [
              {
                type: "function_call",
                call_id: "wait",
                name: "subagent",
                arguments: scheduled("wait", {
                  action: "await",
                  subagentIds: ["review"],
                  timeoutMs: 15_000,
                }),
              },
            ],
            text: "",
          };
        }

        if (mainCalls === 3) {
          return {
            output: [
              {
                type: "function_call",
                call_id: "collect",
                name: "subagent",
                arguments: scheduled("collect", {
                  action: "collect",
                  subagentIds: ["review"],
                }),
              },
            ],
            text: "",
          };
        }

        expect(
          input.some(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === "collect" &&
              item.output.includes(report),
          ),
        ).toBe(true);

        return { output: [], text: "Research collected" };
      },
    };
    const engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      () => model,
    );
    try {
      // 内部夹具直接创建已落盘任务；UI/API 开关另有集成测试。
      const task = store.transaction(() => {
        const created = store.createTask(session.id, true);
        store.event(session.id, created.id, "user", { text: "inspect source" });

        return created;
      });
      await (engine as unknown as { schedule(): Promise<void> }).schedule();
      await engine.active?.done;

      expect(store.task(task.id)?.status).toBe("completed");
      expect(store.subagents(task.id)).toMatchObject([
        {
          id: "review",
          status: "completed",
          consumed: true,
          report,
        },
      ]);
      expect(
        store
          .events(session.id)
          .some((event) => event.type === "subagent_collect"),
      ).toBe(true);
      for (const item of searchOutput) {
        expect(store.subagents(task.id)[0]?.context).toContainEqual(item);
      }

      expect(mainCalls).toBe(4);
      expect(childCalls).toBe(2);
      if (protocol === "responses") {
        expect(mainKeys[0]).toMatch(/^ca1_[a-f0-9]{48}$/);
        expect(childKeys[0]).toMatch(/^ca1_[a-f0-9]{48}$/);
        expect(childKeys[0]).not.toBe(mainKeys[0]);
      } else {
        expect(mainKeys[0]).toBeUndefined();
        expect(childKeys[0]).toBeUndefined();
      }

      expect(new Set(mainKeys).size).toBe(1);
      expect(new Set(childKeys).size).toBe(1);
      const exchanges =
        store.replayCase(task.id)?.capture?.modelExchanges ?? [];
      expect(
        exchanges.filter((exchange) => exchange.purpose === "subagent"),
      ).toHaveLength(2);
      for (const exchange of exchanges) {
        expect(exchange.options?.promptCacheKey).toBe(
          exchange.purpose === "subagent" ? childKeys[0] : mainKeys[0],
        );
      }

      const continued = await engine.start(session.id, "continue", {
        subagentsEnabled: true,
      });
      await engine.active?.done;
      expect(store.task(continued.id)?.status).toBe("completed");
      expect(mainKeys).toHaveLength(5);
      expect(new Set(mainKeys).size).toBe(1);
      expect(await readFile(source, "utf8")).toBe("export const value = 7;\n");
    } finally {
      await engine.close();
      await store.closeAsync();
    }
  },
);

it("keeps a large report unconsumed when the main model only receives a truncated result", async () => {
  const root = await temp();
  await mkdir(path.join(root, "src"));
  const config = new Config(await temp());
  config.settings.outputChars = 1_000;
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const session = store.create(root, "test");
  const largeReport = "evidence".repeat(350);
  let mainCalls = 0;
  const provider: ModelProvider = {
    async run(_input, instructions) {
      if (instructions.includes("read-only research subagent")) {
        return { output: [], text: largeReport };
      }

      mainCalls++;
      if (mainCalls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "plan",
              name: "subagent",
              arguments: scheduled("plan", {
                action: "plan",
                subtasks: [
                  {
                    id: "review",
                    role: "explorer",
                    objective: "inspect",
                    scope: ["src"],
                    dependsOn: [],
                    deliverable: "evidence",
                  },
                ],
              }),
            },
          ],
          text: "",
        };
      }

      if (mainCalls === 2) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "wait",
              name: "subagent",
              arguments: scheduled("wait", {
                action: "await",
                subagentIds: ["review"],
                timeoutMs: 15_000,
              }),
            },
          ],
          text: "",
        };
      }

      if (mainCalls === 3) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "collect",
              name: "subagent",
              arguments: scheduled("collect", {
                action: "collect",
                subagentIds: ["review"],
              }),
            },
          ],
          text: "",
        };
      }

      return { output: [], text: "done" };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
  );
  try {
    const task = store.transaction(() => {
      const created = store.createTask(session.id, true);
      store.event(session.id, created.id, "user", { text: "inspect source" });

      return created;
    });
    await (engine as unknown as { schedule(): Promise<void> }).schedule();
    await engine.active?.done;

    expect(store.task(task.id)?.status).toBe("completed");
    expect(store.subagents(task.id)).toMatchObject([
      { report: largeReport, consumed: false },
    ]);
    expect(store.collectSubagents(task.id, ["review"])).toMatchObject([
      { report: largeReport },
    ]);
  } finally {
    await engine.close();
    await store.closeAsync();
  }
});
