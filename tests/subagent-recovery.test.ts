/*
 * 使用真实 SQLite 重启和模拟模型检查人工恢复只读子任务；发布门禁在本测试文件中单独模拟验收通过。
 *
 * 1. 保存已启动但未确认的子模型请求，重启后核对任务/请求分别变为 interrupted/unknown。
 * 2. 恢复继承来源任务的启用选择并重新读取工作区当前文件，旧 Worker 不被自动重建或重放。
 * 3. 旧检查点与未知状态仍可从历史查询，新任务的子任务账本从空开始，主模型自行决定是否重规划。
 *
 * Mock 仅解除 Engine.start 的发布门禁，不模拟 Windows Sandbox 或真实模型执行。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

vi.mock("../src/agent/subagent-readiness.js", () => ({
  SUBAGENT_PUBLIC_READY: true,
}));

it("inherits opt-in without restarting interrupted Workers or retrying unknown model requests", async () => {
  const workspace = await temp();
  await mkdir(path.join(workspace, "src"));
  const source = path.join(workspace, "src", "evidence.ts");
  await writeFile(source, "export const current = 1;\n");
  const config = new Config(await temp());
  const database = path.join(config.directory, "history.sqlite");
  let store = new Store(database);
  const session = store.create(workspace, "unfinished research");
  const original = store.transaction(() => {
    const created = store.createTask(session.id, true);
    store.event(session.id, created.id, "user", { text: "inspect evidence" });

    return created;
  });
  store.status(original.id, "running");
  store.planSubagents(original.id, [
    {
      id: "reader",
      role: "researcher",
      objective: "inspect evidence",
      scope: ["src"],
      dependsOn: [],
      deliverable: "file and line",
    },
  ]);
  store.updateSubagent(original.id, "reader", "running", [
    { role: "user", content: "research" },
  ]);
  store.startSubagentRequest(original.id, "reader", "model-1", "model");
  store.close();

  await writeFile(source, "export const current = 2;\n");
  store = new Store(database);
  let modelCalls = 0;
  const provider: ModelProvider = {
    async run(input, instructions, tools) {
      modelCalls++;
      expect(instructions).not.toContain("read-only research subagent");
      expect(tools.some((tool) => tool.name === "subagent")).toBe(true);
      if (modelCalls === 1) {
        return {
          output: [
            {
              type: "function_call",
              name: "read_file",
              call_id: "fresh-read",
              arguments: JSON.stringify({
                execution: { id: "inspect", dependsOn: [] },
                arguments: {
                  path: "src/evidence.ts",
                  startLine: 1,
                  endLine: 1,
                },
              }),
            },
          ],
          text: "",
        };
      }

      expect(JSON.stringify(input)).toContain("current = 2");

      return { output: [], text: "Resumed without replay" };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
  );

  try {
    expect(store.task(original.id)?.status).toBe("interrupted");
    expect(store.subagents(original.id)).toMatchObject([
      { id: "reader", status: "interrupted" },
    ]);
    expect(
      store.subagentRequest(original.id, "reader", "model-1")?.status,
    ).toBe("unknown");

    const resumed = engine.resume(original.id, "verify current files first");
    await engine.active?.done;

    expect(store.task(resumed.id)).toMatchObject({
      status: "completed",
      subagentsEnabled: true,
    });
    expect(store.subagents(resumed.id)).toEqual([]);
    expect(
      store.subagentRequest(original.id, "reader", "model-1")?.status,
    ).toBe("unknown");
    expect(
      store
        .events(session.id)
        .filter((event) => event.type === "subagent_plan"),
    ).toHaveLength(1);
    expect(store.taskEvent(resumed.id, "recovery")).toMatchObject({
      sourceTaskId: original.id,
    });
    expect(await readFile(source, "utf8")).toBe("export const current = 2;\n");
    expect(modelCalls).toBe(2);
  } finally {
    await engine.close();
    store.close();
  }
});
