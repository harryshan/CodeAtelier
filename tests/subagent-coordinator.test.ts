/*
 * 使用真实临时工作区、SQLite 和 Worker 验证主任务的子任务协调闭环，不调用外部模型。
 *
 * 1. 逆序声明有依赖的两个计划，验证持久化先于线程、有限租约、文件读取、等待及只收集一次报告。
 * 2. 敏感/越界范围拒绝时不创建任务；取消等待模型的 Worker 后归还资源并标记终态。
 * 3. 主任务关闭时与尚在登记计划的请求竞态，不能遗漏晚登记的 Worker。
 *
 * 模拟 ModelProvider 是协议桩，不能作为真实 Windows 专用账户 Sandbox 验收证据。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  SubagentCoordinator,
  type SubagentStorage,
} from "../src/agent/subagent-coordinator.js";
import { SubagentLimits } from "../src/agent/subagent-limits.js";
import { Store } from "../src/sessions/store.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { temp } from "./fixtures/helpers.js";

const plan = (id: string, dependsOn: string[] = []) => ({
  id,
  role: "researcher",
  objective: `inspect code as ${id}`,
  scope: ["src"],
  dependsOn,
  deliverable: "cite a line",
});

async function setup(provider: ModelProvider) {
  const root = await temp();
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "example.ts"),
    "export const value = 1;\n",
  );
  const store = new Store(path.join(root, "history.sqlite"));
  const session = store.create(root);
  const task = store.createTask(session.id, true);
  store.status(task.id, "running");
  const trace: string[] = [];
  const coordinator = new SubagentCoordinator({
    taskId: task.id,
    workspace: root,
    storage: store,
    provider,
    limits: new SubagentLimits(1),
    signal: new AbortController().signal,
    trace: (name, id, status) => trace.push(`${name}:${id}:${status}`),
  });

  return { root, store, task, coordinator, trace };
}

it("runs separate loops in dependency order and persists reports for only one collection", async () => {
  const order: string[] = [];
  const provider: ModelProvider = {
    run: async (input) => {
      const first = input[0].content as string;
      const id = first.includes("as first") ? "first" : "second";
      if (input.some((record) => record.type === "function_call_output")) {
        order.push(`done:${id}`);

        return { output: [], text: "Line 1: value is 1" };
      }

      order.push(`start:${id}`);

      return {
        output: [
          {
            type: "function_call",
            call_id: "read-1",
            name: "read_file",
            arguments: JSON.stringify({
              execution: { id: "read", dependsOn: [] },
              arguments: { path: "src/example.ts", startLine: 1, endLine: 1 },
            }),
          },
        ],
        text: "",
      };
    },
  };
  const fixture = await setup(provider);
  try {
    await expect(
      fixture.coordinator.execute({
        action: "plan",
        subtasks: [plan("second", ["first"]), plan("first")],
      }),
    ).resolves.toMatchObject({ subtasks: [{ id: "second" }, { id: "first" }] });
    const done = await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["second", "first"],
      timeoutMs: 15_000,
    });
    expect(done).toMatchObject({
      subtasks: [
        { id: "second", status: "completed" },
        { id: "first", status: "completed" },
      ],
    });
    expect(order).toEqual([
      "start:first",
      "done:first",
      "start:second",
      "done:second",
    ]);
    expect(
      fixture.store.subagentRequest(fixture.task.id, "first", "read-1")?.status,
    ).toBe("completed");
    expect(
      fixture.store.subagentRequest(fixture.task.id, "second", "read-1")
        ?.status,
    ).toBe("completed");
    const collected = await fixture.coordinator.execute({
      action: "collect",
      subagentIds: ["first", "second"],
    });
    expect(collected).toMatchObject({
      reports: [
        { report: "Line 1: value is 1" },
        { report: "Line 1: value is 1" },
      ],
    });
    expect(
      await fixture.coordinator.execute({
        action: "collect",
        subagentIds: ["first"],
      }),
    ).toMatchObject({
      reports: [{ report: "Line 1: value is 1", consumed: false }],
    });
    fixture.store.commitSubagentCollect(
      fixture.task.id,
      ["first", "second"],
      () => {
        fixture.store.event(
          fixture.task.sessionId,
          fixture.task.id,
          "tool_result",
          collected,
        );
        fixture.store.saveContext(fixture.task.sessionId, [
          { type: "function_call_output", output: JSON.stringify(collected) },
        ]);
      },
    );
    expect(
      fixture.store.subagents(fixture.task.id).map(({ consumed }) => consumed),
    ).toEqual([true, true]);
    expect(fixture.trace).toContain("subagent.worker:first:completed");
  } finally {
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("rejects sensitive scopes before persistence and cancels waiting model work", async () => {
  const provider: ModelProvider = {
    run: async (_input, _instructions, _tools, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  };
  const fixture = await setup(provider);
  try {
    await expect(
      fixture.coordinator.execute({
        action: "plan",
        subtasks: [{ ...plan("bad"), scope: [".env"] }],
      }),
    ).rejects.toThrow();
    expect(fixture.store.subagents(fixture.task.id)).toEqual([]);
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("good")],
    });
    await fixture.coordinator.close();
    expect(fixture.store.subagents(fixture.task.id)).toMatchObject([
      { id: "good", status: "cancelled" },
    ]);
  } finally {
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("joins plans already registering when the parent task closes", async () => {
  const fixture = await setup({
    run: async () => ({ output: [], text: "late response" }),
  });
  let releasePlan!: () => void;
  let enteredPlan!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePlan = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredPlan = resolve;
  });
  const storage: SubagentStorage = {
    planSubagents: async (taskId, plans) => {
      enteredPlan();
      await gate;

      return fixture.store.planSubagents(taskId, plans);
    },
    subagents: fixture.store.subagents.bind(fixture.store),
    updateSubagent: fixture.store.updateSubagent.bind(fixture.store),
    startSubagentRequest: fixture.store.startSubagentRequest.bind(
      fixture.store,
    ),
    finishSubagentRequest: fixture.store.finishSubagentRequest.bind(
      fixture.store,
    ),
    collectSubagents: fixture.store.collectSubagents.bind(fixture.store),
  };
  const coordinator = new SubagentCoordinator({
    taskId: fixture.task.id,
    workspace: fixture.root,
    storage,
    provider: { run: async () => ({ output: [], text: "late response" }) },
    limits: new SubagentLimits(1),
    signal: new AbortController().signal,
  });
  try {
    const planning = coordinator.execute({
      action: "plan",
      subtasks: [plan("late")],
    });
    await entered;
    const closing = coordinator.close();
    releasePlan();
    await planning;
    await closing;

    expect(fixture.store.subagents(fixture.task.id)).toMatchObject([
      { id: "late", status: "cancelled" },
    ]);
  } finally {
    releasePlan();
    await coordinator.close();
    await fixture.coordinator.close();
    fixture.store.close();
  }
});
