/*
 * 验证 subagent 不再施加独立的研究次数、文本及累计任务数量阈值。
 *
 * 1. 工具与 Runtime IPC 契约接受超过旧阈值的计划、问题和检查点，仍拒绝空问题和非法字段。
 * 2. 真实 SQLite 保存长上下文、完整报告和请求结果，并能一次收集超过四份报告。
 * 3. 真实 Worker/协调器完成超过十二轮的长问题调查，保留完整报告、用量和全部待答问题。
 *
 * 所有文件位于临时工作区，模型使用本地桩；不运行 Evaluation 或真实模型，也不证明安装态 Sandbox 验收。
 */

import path from "node:path";
import { expect, it } from "vitest";
import {
  subagentActionSchema,
  validateSubagentPlan,
} from "../src/agent/subagent-contracts.js";
import { askMainArguments } from "../src/agent/subagent-question-contract.js";
import { SubagentCoordinator } from "../src/agent/subagent-coordinator.js";
import { SubagentLimits } from "../src/agent/subagent-limits.js";
import {
  runtimeRequestSchema,
  runtimeSubagentStoreSchema,
} from "../src/sandbox/runtime-ipc-protocol.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

const plan = (id: string) => ({
  id,
  role: "researcher".repeat(20),
  objective: "investigate".repeat(200),
  scope: ["."],
  dependsOn: [] as string[],
  deliverable: "evidence".repeat(100),
});

it("accepts large plans and text through both contracts without weakening validation", () => {
  const subtasks = Array.from({ length: 6 }, (_, index) =>
    plan(`child${index}`),
  );
  subtasks[5].dependsOn = subtasks.slice(0, 5).map(({ id }) => id);
  subtasks[0].scope = Array.from(
    { length: 10 },
    (_, index) => `src/${index}/${"a".repeat(1_025)}`,
  );
  const request = { action: "plan", subtasks };
  expect(subagentActionSchema.parse({ request }).request).toEqual(request);
  expect(runtimeSubagentStoreSchema.parse(request)).toEqual(request);
  expect(validateSubagentPlan(subtasks, new Set(["earlier"]))).toEqual(
    subtasks,
  );

  const question = "clarification?".repeat(200);
  expect(askMainArguments.parse({ question })).toEqual({ question });
  expect(
    runtimeSubagentStoreSchema.parse({
      action: "question",
      subagentId: "child0",
      requestId: "q1",
      question,
    }),
  ).toMatchObject({ question });
  expect(() => askMainArguments.parse({ question: " " })).toThrow();
  expect(() =>
    askMainArguments.parse({ question, command: "write" }),
  ).toThrow();
  expect(
    subagentActionSchema.parse({
      request: {
        action: "message",
        subagentId: "child0",
        text: "reply".repeat(1_000),
      },
    }).request,
  ).toMatchObject({ text: "reply".repeat(1_000) });

  const context = Array.from({ length: 2_001 }, () => ({
    role: "user",
    content: "x".repeat(1_001),
  }));
  const report = "report".repeat(6_000);
  expect(
    runtimeSubagentStoreSchema.parse({
      action: "update",
      subagentId: "child0",
      status: "completed",
      context,
      report,
    }),
  ).toMatchObject({ context, report });
  const ids = subtasks.map(({ id }) => id);
  expect(
    subagentActionSchema.parse({
      request: { action: "collect", subagentIds: ids },
    }).request,
  ).toMatchObject({ subagentIds: ids });
  expect(runtimeSubagentStoreSchema.parse({ action: "collect", ids })).toEqual({
    action: "collect",
    ids,
  });
  expect(
    subagentActionSchema.parse({
      request: { action: "await", subagentIds: ids, timeoutMs: 100 },
    }).request,
  ).toMatchObject({ subagentIds: ids });
  expect(
    runtimeRequestSchema.parse({
      type: "request",
      requestId: "collect",
      operation: "session_commit_subagent_collect",
      body: {
        ids,
        input: [],
        event: {
          name: "subagent",
          callId: "collect",
          batchId: "batch",
          nodeId: "collect",
          result: {},
        },
      },
    }),
  ).toMatchObject({ body: { ids } });
});

it("persists complete large checkpoints and results and collects more than four reports", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));
  try {
    const session = store.create(root);
    const task = store.createTask(session.id, true);
    store.status(task.id, "running");
    const subtasks = Array.from({ length: 6 }, (_, index) => ({
      ...plan(`child${index}`),
      role: "reader",
      objective: "inspect",
      deliverable: "report",
    }));
    store.planSubagents(task.id, subtasks.slice(0, 4));
    store.planSubagents(task.id, subtasks.slice(4));
    const context = [{ role: "user", content: "x".repeat(2_000_001) }];
    const report = "r".repeat(32_001);
    for (const { id } of subtasks) {
      store.updateSubagent(task.id, id, "running", context);
      store.recordSubagentQuestion(task.id, id, "q1", "?".repeat(1_001));
      store.startSubagentRequest(task.id, id, "m1", "model");
      store.finishSubagentRequest(task.id, id, "m1", { output: context });
      store.updateSubagent(task.id, id, "completed", context, report);
    }

    expect(
      store
        .subagents(task.id)
        .every(
          (child) => JSON.stringify(child.context) === JSON.stringify(context),
        ),
    ).toBe(true);
    expect(store.subagentRequest(task.id, "child0", "m1")).toMatchObject({
      status: "completed",
      result: { output: context },
    });
    expect(
      store
        .collectSubagents(
          task.id,
          subtasks.map(({ id }) => id),
        )
        .map((child) => child.report),
    ).toEqual(Array(6).fill(report));
  } finally {
    store.close();
  }
});

it("finishes long research beyond the former round, token, question and character caps", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));
  const session = store.create(root);
  const task = store.createTask(session.id, true);
  store.status(task.id, "running");
  let calls = 0;
  let tokens = 0;
  const question = "q".repeat(6_000);
  const report = "evidence".repeat(5_000);
  const coordinator = new SubagentCoordinator({
    taskId: task.id,
    workspace: root,
    storage: store,
    limits: new SubagentLimits(),
    signal: new AbortController().signal,
    onUsage: (_id, usage) => {
      tokens += usage.total_tokens;
    },
    provider: {
      async run(input, _instructions, _tools, _signal, _delta, options) {
        calls++;
        expect(options?.maxOutputTokens).toBeUndefined();
        const usage = {
          input_tokens: 30_000,
          output_tokens: 10_000,
          total_tokens: 40_000,
        };
        if (calls === 21) {
          expect(JSON.stringify(input).length).toBeGreaterThan(100_000);
          expect(input.length).toBeGreaterThan(2_000);
          expect(
            input.filter((item) => item.type === "function_call_output"),
          ).toHaveLength(20);

          return { text: report, output: [], usage };
        }

        return {
          text: "",
          usage,
          output: [
            ...(calls === 1
              ? Array.from({ length: 2_001 }, (_, index) => ({
                  role: "assistant",
                  content: `evidence ${index}`,
                }))
              : []),
            {
              type: "function_call",
              call_id: `q${calls}`,
              name: "ask_main",
              arguments: JSON.stringify({
                execution: { id: `q${calls}`, dependsOn: [] },
                arguments: { question },
              }),
            },
          ],
        };
      },
    },
  });
  try {
    await coordinator.execute({ action: "plan", subtasks: [plan("reader")] });
    await expect
      .poll(() => store.subagents(task.id)[0]?.status, { timeout: 15_000 })
      .toBe("completed");
    expect(calls).toBe(21);
    expect(tokens).toBe(840_000);
    expect(
      await coordinator.execute({ action: "collect", subagentIds: ["reader"] }),
    ).toMatchObject({ reports: [{ report }] });
    const waiting = await coordinator.execute({
      action: "await",
      subagentIds: ["reader"],
      timeoutMs: 100,
    });
    expect("questions" in waiting && waiting.questions).toHaveLength(20);
    expect(
      store
        .events(session.id)
        .filter((event) => event.type === "subagent_question"),
    ).toHaveLength(20);
  } finally {
    await coordinator.close();
    store.close();
  }
});
