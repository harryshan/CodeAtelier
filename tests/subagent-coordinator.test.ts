/*
 * 使用真实临时工作区、SQLite 和 Worker 验证主任务的子任务协调闭环，不调用外部模型。
 *
 * 1. 逆序声明有依赖的两个计划，验证计划/状态持久化后通知页面刷新、有限租约、读取、等待及只收集一次报告。
 * 2. 敏感/越界范围拒绝时不创建任务；取消等待模型的 Worker 后归还资源并标记终态。
 * 3. 主任务关闭时与尚在登记计划的请求竞态，不能遗漏晚登记的 Worker。
 * 4. 超过旧时长/问题/消息阈值仍继续研究，主任务取消仍立刻停止；累计 token 与长轮次由 subagent-capacity.test.ts 统一覆盖。延迟模型先确认 Worker 就绪，再验证子问题唤醒一秒 await；主代理核验归属后才可带关联 ID 回复。
 *
 * 模拟 ModelProvider 是协议桩，不能作为真实 Windows 专用账户 Sandbox 验收证据。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
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
  const notifications: string[] = [];
  const coordinator = new SubagentCoordinator({
    taskId: task.id,
    workspace: root,
    storage: store,
    provider,
    limits: new SubagentLimits(1),
    signal: new AbortController().signal,
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
    recordSubagentQuestion: fixture.store.recordSubagentQuestion.bind(
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

it("keeps research running beyond the former deadline until explicitly cancelled", async () => {
  let modelCalls = 0;
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  const provider: ModelProvider = {
    run: async (_input, _instructions, _tools, signal) => {
      modelCalls++;
      modelStarted();

      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  const fixture = await setup(provider);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    await started;
    await vi.advanceTimersByTimeAsync(120_001);
    expect(fixture.store.subagents(fixture.task.id)[0].status).toBe("running");
    vi.useRealTimers();
    await fixture.coordinator.execute({
      action: "cancel",
      subagentId: "reader",
    });
    const result = await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      subtasks: [{ id: "reader", status: "cancelled" }],
    });
    expect(fixture.store.subagents(fixture.task.id)).toMatchObject([
      {
        id: "reader",
        status: "cancelled",
      },
    ]);
    expect(fixture.trace).toContain("subagent.worker:reader:cancelled");
    expect(modelCalls).toBe(1);
  } finally {
    vi.useRealTimers();
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("persists a child question and lets only the main coordinator answer it", async () => {
  let modelCalls = 0;
  let markWorkerReady!: () => void;
  const workerReady = new Promise<void>((resolve) => {
    markWorkerReady = resolve;
  });
  let releaseQuestion!: () => void;
  const question = new Promise<void>((resolve) => {
    releaseQuestion = resolve;
  });
  let releaseSecond!: () => void;
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const provider: ModelProvider = {
    async run(input) {
      modelCalls++;
      if (modelCalls === 1) {
        await delay(1100);
        markWorkerReady();
        await question;

        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "ask",
              name: "ask_main",
              arguments: JSON.stringify({
                execution: { id: "ask", dependsOn: [] },
                arguments: { question: "Which file should I inspect?" },
              }),
            },
          ],
        };
      }

      if (modelCalls === 2) {
        await second;

        return {
          text: "",
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

      expect(JSON.stringify(input)).toContain("Main reply to question");

      return { text: "src/example.ts:1", output: [] };
    },
  };
  const fixture = await setup(provider);
  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    // 先确认真实 Worker 已进入模型请求，再检查一秒 await 被新问题唤醒。
    await workerReady;
    const awaitingQuestion = fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 1_000,
    });
    releaseQuestion();
    const waiting = await awaitingQuestion;
    expect(waiting).toMatchObject({
      questions: [
        {
          id: expect.any(Number),
          subagentId: "reader",
          question: "Which file should I inspect?",
        },
      ],
    });
    if (!("questions" in waiting) || !waiting.questions?.length) {
      throw new Error("主协调器没有收到已保存的问题。");
    }

    const questionId = waiting.questions[0].id;
    expect(fixture.notifications).toContain("subagent_question");
    await expect(
      fixture.coordinator.execute({
        action: "message",
        subagentId: "reader",
        replyTo: questionId + 1,
        text: "wrong",
      }),
    ).rejects.toThrow();
    await expect(
      fixture.coordinator.execute({
        action: "message",
        subagentId: "reader",
        replyTo: questionId,
        text: "Look at src/example.ts",
      }),
    ).resolves.toMatchObject({ accepted: true });
    releaseSecond();
    const done = await fixture.coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 15_000,
    });
    expect(done).toMatchObject({
      subtasks: [{ id: "reader", status: "completed" }],
      questions: [],
    });
    expect(
      await fixture.coordinator.execute({
        action: "collect",
        subagentIds: ["reader"],
      }),
    ).toMatchObject({ reports: [{ report: "src/example.ts:1" }] });
  } finally {
    releaseQuestion();
    releaseSecond();
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("persists questions beyond the former count limit while deduplicating confirmed requests", async () => {
  let modelCalls = 0;
  const provider: ModelProvider = {
    async run(input) {
      modelCalls++;
      if (modelCalls === 22) {
        expect(
          input.filter((item) => item.type === "function_call_output"),
        ).toHaveLength(21);

        return { text: "questions completed", output: [] };
      }

      if (modelCalls === 10) {
        const acks = input
          .filter(
            (item) =>
              item.type === "function_call_output" && item.call_id === "ask-8",
          )
          .map(
            (item) =>
              JSON.parse(String(item.output)) as {
                id?: number;
                queued?: boolean;
              },
          );
        expect(acks).toHaveLength(2);
        expect(acks[0]).toEqual(acks[1]);
        expect(acks[0].queued).toBe(true);
      }

      const number = modelCalls >= 9 ? modelCalls - 1 : modelCalls;

      return {
        text: "",
        output: [
          {
            type: "function_call",
            call_id: `ask-${number}`,
            name: "ask_main",
            arguments: JSON.stringify({
              execution: { id: `ask-${number}`, dependsOn: [] },
              arguments: { question: `Question ${number}?` },
            }),
          },
        ],
      };
    },
  };
  const fixture = await setup(provider);
  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    await expect
      .poll(() => fixture.store.subagents(fixture.task.id)[0]?.status, {
        timeout: 10_000,
      })
      .toBe("completed");
    expect(
      fixture.store
        .events(fixture.task.sessionId)
        .filter((event) => event.type === "subagent_question"),
    ).toHaveLength(20);
    expect(modelCalls).toBe(22);
    expect(fixture.store.subagents(fixture.task.id)[0].report).toBe(
      "questions completed",
    );
  } finally {
    await fixture.coordinator.close();
    fixture.store.close();
  }
});

it("delivers more than sixteen long messages at the next child model step", async () => {
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  let releaseModel!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const notes = Array.from(
    { length: 20 },
    (_, index) => `note ${index}: ${"x".repeat(2_001)}`,
  );
  let modelCalls = 0;
  const provider: ModelProvider = {
    async run(input) {
      modelCalls++;
      if (modelCalls === 1) {
        modelStarted();
        await gate;

        return {
          text: "",
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

      expect(
        input
          .filter((item) => item.role === "user")
          .slice(1)
          .map((item) => item.content),
      ).toEqual(notes);

      return { text: "all notes received", output: [] };
    },
  };
  const fixture = await setup(provider);
  try {
    await fixture.coordinator.execute({
      action: "plan",
      subtasks: [plan("reader")],
    });
    await started;
    for (const text of notes) {
      await expect(
        fixture.coordinator.execute({
          action: "message",
          subagentId: "reader",
          text,
        }),
      ).resolves.toMatchObject({ accepted: true });
    }

    releaseModel();
    expect(
      await fixture.coordinator.execute({
        action: "await",
        subagentIds: ["reader"],
        timeoutMs: 15_000,
      }),
    ).toMatchObject({ subtasks: [{ id: "reader", status: "completed" }] });
    expect(fixture.store.subagents(fixture.task.id)[0].report).toBe(
      "all notes received",
    );
    expect(
      fixture.trace.filter((item) => item === "subagent.message:reader:ok"),
    ).toHaveLength(20);
  } finally {
    releaseModel();
    await fixture.coordinator.close();
    fixture.store.close();
  }
});
