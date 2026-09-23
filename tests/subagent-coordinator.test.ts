/*
 * 使用真实临时工作区、SQLite 和 Worker 验证主任务的子任务协调闭环，不调用外部模型。
 *
 * 1. 逆序声明有依赖的两个计划，验证计划/状态持久化后通知页面刷新、有限租约、读取、等待及只收集一次报告。
 * 2. 敏感/越界范围拒绝时不创建任务；取消等待模型的 Worker 后归还资源并标记终态。
 * 3. 主任务关闭时与尚在登记计划的请求竞态，不能遗漏晚登记的 Worker。
 * 4. 等待在主任务取消时立刻停止；每个子任务的运行时间、累计实报 token、消息数有界，超限仅在 Worker 退出后归还额度。
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

async function setup(
  provider: ModelProvider,
  budget: { maxChildDurationMs?: number; maxChildTokens?: number } = {},
) {
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
  const notifications: string[] = [];
  const coordinator = new SubagentCoordinator({
    taskId: task.id,
    workspace: root,
    storage: store,
    provider,
    limits: new SubagentLimits(1),
    signal: new AbortController().signal,
    ...budget,
    trace: (name, id, status) => trace.push(`${name}:${id}:${status}`),
    onStateChange: () =>
      notifications.push(store.events(session.id).at(-1)?.type ?? "missing"),
  });

  return { root, store, task, coordinator, trace, notifications };
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
    expect(fixture.notifications).toContain("subagent_plan");

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
    expect(
      fixture.notifications.filter((type) => type === "subagent_state").length,
    ).toBeGreaterThanOrEqual(6);
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
      fixture.store.collectSubagents(fixture.task.id, ["first", "second"]),
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

it("does not resume the child model when a read result cannot be persisted", async () => {
  let modelCalls = 0;
  const provider: ModelProvider = {
    run: async () => {
      modelCalls++;
      if (modelCalls === 1) {
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
      }

      return { output: [], text: "incorrect success" };
    },
  };
  const fixture = await setup(provider);
  const original = fixture.store.finishSubagentRequest.bind(fixture.store);
  fixture.store.finishSubagentRequest = (...args) => {
    if (args[2] === "read-1") {
      throw new Error("simulated storage outage");
    }

    return original(...args);
  };

  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 15_000,
    });
    expect(fixture.store.subagents(fixture.task.id)).toMatchObject([
      { id: "reader", status: "failed" },
    ]);
    expect(modelCalls).toBe(1);
    expect(
      fixture.store.subagentRequest(fixture.task.id, "reader", "read-1")
        ?.status,
    ).toBe("started");
  } finally {
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("stops waiting immediately when the main task is cancelled", async () => {
  const provider: ModelProvider = {
    run: async (_input, _instructions, _tools, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  };
  const fixture = await setup(provider);
  const controller = new AbortController();
  const coordinator = new SubagentCoordinator({
    taskId: fixture.task.id,
    workspace: fixture.root,
    storage: fixture.store,
    provider,
    limits: new SubagentLimits(1),
    signal: controller.signal,
  });
  try {
    await coordinator.execute({ action: "plan", subtasks: [plan("reader")] });
    await coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 100,
    });
    const waiting = coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 500,
    });
    controller.abort(new Error("main task cancelled"));
    await expect(waiting).rejects.toThrow("main task cancelled");
  } finally {
    await coordinator.close();
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("fails a stalled Worker after its own wall-clock limit and releases its lease", async () => {
  let modelCalls = 0;
  const provider: ModelProvider = {
    run: async (_input, _instructions, _tools, signal) => {
      modelCalls++;

      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  const fixture = await setup(provider, { maxChildDurationMs: 2_500 });
  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    await expect.poll(() => modelCalls).toBe(1);
    const result = await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      subtasks: [{ id: "reader", status: "failed" }],
    });
    expect(fixture.store.subagents(fixture.task.id)).toMatchObject([
      {
        id: "reader",
        status: "failed",
        report: expect.stringContaining("运行时间"),
      },
    ]);
    expect(fixture.trace).toContain("subagent.worker:reader:failed");
    expect(modelCalls).toBe(1);
  } finally {
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("stops after the reported cumulative token budget without replaying the last model call", async () => {
  let modelCalls = 0;
  const usage = {
    input_tokens: 17_000,
    output_tokens: 1_000,
    total_tokens: 18_000,
  };
  const provider: ModelProvider = {
    async run() {
      modelCalls++;
      if (modelCalls === 1) {
        return {
          text: "",
          usage,
          output: [
            {
              type: "function_call",
              call_id: "read",
              name: "read_file",
              arguments: JSON.stringify({
                execution: { id: "read", dependsOn: [] },
                arguments: { path: "src/example.ts", startLine: 1, endLine: 1 },
              }),
            },
          ],
        };
      }

      return { text: "should not finish", usage, output: [] };
    },
  };
  const fixture = await setup(provider, { maxChildTokens: 30_000 });
  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    const result = await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      subtasks: [{ id: "reader", status: "failed" }],
    });
    expect(fixture.store.subagents(fixture.task.id)).toMatchObject([
      {
        id: "reader",
        status: "failed",
        report: expect.stringContaining("token"),
      },
    ]);
    expect(
      fixture.store.subagentRequest(fixture.task.id, "reader", "model-5")
        ?.status,
    ).toBe("completed");
    expect(modelCalls).toBe(2);
  } finally {
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("caps queued messages while a child model is blocked", async () => {
  const provider: ModelProvider = {
    run: async (_input, _instructions, _tools, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  };
  const fixture = await setup(provider);
  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 100,
    });
    for (let index = 0; index < 16; index++) {
      await expect(
        fixture.coordinator.execute({
          action: "message",
          subagentId: "reader",
          text: `note ${index}`,
        }),
      ).resolves.toMatchObject({ accepted: true });
    }

    await expect(
      fixture.coordinator.execute({
        action: "message",
        subagentId: "reader",
        text: "overflow",
      }),
    ).rejects.toThrow("消息上限");
    expect(
      fixture.trace.filter((item) => item === "subagent.message:reader:ok"),
    ).toHaveLength(16);
    await fixture.coordinator.execute({
      action: "cancel",
      subagentId: "reader",
    });
    await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 15_000,
    });
    expect(fixture.trace).toContain("subagent.cancel:reader:cancelled");
  } finally {
    await fixture.coordinator.close();
    fixture.store.close();
  }
});
