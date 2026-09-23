/*
 * 用生产 Engine、真实 SQLite 与 Worker 和模拟 Responses 模型验证可选 subagent 的宿主执行路径。
 *
 * 1. 在 UI/API 开关尚未开放时，经内部排队记录启动已标记任务；主模型按 plan/await/collect 协调。
 * 2. 子 Worker 仅看到三个文件只读工具及向主协调器提问的无写入通道；报告消费与主反馈共同持久化。
 * 3. 超过主任务工具输出预算的报告保留未消费状态，以便恢复后重新读取；原代码文件不得被子任务改写。
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

it("coordinates read-only research and commits collected feedback in the host Engine", async () => {
  const root = await temp();
  await mkdir(path.join(root, "src"));
  const source = path.join(root, "src", "sample.ts");
  await writeFile(source, "export const value = 7;\n");
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const session = store.create(root, "test");
  let mainCalls = 0;
  let childCalls = 0;
  const model: ModelProvider = {
    async run(input, instructions, tools) {
      if (instructions.includes("read-only research subagent")) {
        childCalls++;
        expect(tools.map((tool) => tool.name)).toEqual([
          "read_file",
          "list_entries",
          "search_text",
          "ask_main",
        ]);
        if (childCalls === 1) {
          return {
            output: [
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

        expect(input.some((item) => item.type === "function_call_output")).toBe(
          true,
        );

        return { output: [], text: "sample.ts:1 value is 7" };
      }

      mainCalls++;
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
                    role: "reader",
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
            item.output.includes("sample.ts:1 value is 7"),
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
    // 内部夹具测试已落盘的任务；正式 API 仍明确拒绝 true，未提前开放未完成的 Sandbox 路径。
    const task = store.transaction(() => {
      const created = store.createTask(session.id, true);
      store.event(session.id, created.id, "user", { text: "inspect source" });

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
        report: "sample.ts:1 value is 7",
      },
    ]);
    expect(
      store
        .events(session.id)
        .some((event) => event.type === "subagent_collect"),
    ).toBe(true);
    expect(mainCalls).toBe(4);
    expect(childCalls).toBe(2);
    expect(await readFile(source, "utf8")).toBe("export const value = 7;\n");
  } finally {
    await engine.close();
    store.close();
  }
});

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
                    role: "reader",
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
    (engine as unknown as { schedule(): void }).schedule();
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
    store.close();
  }
});
