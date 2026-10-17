/*
 * 验证 explorer/reviewer 契约、干净上下文及多实例范围隔离，使用真实 Worker、SQLite 和临时文件。
 *
 * 1. 计划夹具生成两种内置角色；工具和 Runtime IPC 都拒绝未知角色及缺失的 reviewer 材料。
 * 2. 上下文构造只投递分工字段，不接受夹带的主历史、记忆或同伴上下文，每次调用创建独立数组。
 * 3. 同角色和混合角色的两个 Worker 必须同时到达模型屏障，随后读取各自范围、拒绝跨范围读取，
 *    独立落盘报告并由主协调器收集；父上下文及依赖报告不得自动进入子模型，trace 不包含正文。
 *
 * 模型为确定性桩，不证明真实模型一定筛选得当或发现缺陷，也不代替安装态 Sandbox 验收。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  subagentActionSchema,
  type SubtaskPlan,
} from "../src/agent/subagent-contracts.js";
import { createSubagentContext } from "../src/agent/subagent-prompts.js";
import { SubagentCoordinator } from "../src/agent/subagent-coordinator.js";
import { SubagentLimits } from "../src/agent/subagent-limits.js";
import { runtimeSubagentStoreSchema } from "../src/sandbox/runtime-ipc-protocol.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

type Role = SubtaskPlan["role"];

function plan(id: string, role: Role): SubtaskPlan {
  const common = {
    id,
    objective: `Inspect ${id}`,
    scope: [`src/${id}`],
    dependsOn: [] as string[],
    deliverable: "Evidence and limitations",
  };

  return role === "reviewer"
    ? {
        ...common,
        role,
        changes: `src/${id}/value.ts: baseline value = 0; current value = 1`,
      }
    : { ...common, role };
}

it("validates built-in roles and required review evidence at both plan boundaries", () => {
  const valid = {
    action: "plan",
    subtasks: [plan("a", "explorer"), plan("b", "reviewer")],
  };
  expect(subagentActionSchema.parse({ request: valid }).request).toEqual(valid);
  expect(runtimeSubagentStoreSchema.parse(valid)).toEqual(valid);

  for (const invalid of [
    { ...plan("a", "explorer"), role: "researcher" },
    { ...plan("a", "explorer"), role: "reviewer" },
    { ...plan("a", "reviewer"), changes: " " },
    { ...plan("a", "explorer"), changes: "unexpected" },
    { ...plan("a", "reviewer"), parentContext: ["private"] },
  ]) {
    const request = { action: "plan", subtasks: [invalid] };
    expect(subagentActionSchema.safeParse({ request }).success).toBe(false);
    expect(runtimeSubagentStoreSchema.safeParse(request).success).toBe(false);
  }
});

it("builds a fresh reviewer context from explicit evidence rather than inherited material", () => {
  const input = {
    ...plan("a", "reviewer"),
    taskId: "task",
    context: ["parent-history-sentinel"],
    memory: "memory-sentinel",
    reports: ["peer-report-sentinel"],
  };
  const first = createSubagentContext(input);
  const second = createSubagentContext(input);
  expect(first.input).toHaveLength(1);
  expect(JSON.stringify(first.input)).toContain("baseline value = 0");
  expect(JSON.stringify(first)).not.toMatch(
    /parent-history-sentinel|memory-sentinel|peer-report-sentinel/,
  );
  first.input.push({ role: "assistant", content: "previous review" });
  expect(second.input).toHaveLength(1);
  expect(second.input).not.toBe(first.input);
});

it.each([
  ["explorer", "explorer"],
  ["reviewer", "reviewer"],
  ["explorer", "reviewer"],
] as const)(
  "runs %s and %s concurrently with isolated scopes and contexts",
  async (firstRole, secondRole) => {
    const root = await temp();
    for (const id of ["a", "b"]) {
      await mkdir(path.join(root, "src", id), { recursive: true });
      await writeFile(
        path.join(root, "src", id, "value.ts"),
        `export const value = 1; // evidence-${id}\n`,
      );
    }

    const store = new Store(path.join(root, "history.sqlite"));
    const session = store.create(root);
    const task = store.createTask(session.id, true);
    store.status(task.id, "running");
    store.saveContext(session.id, [
      { role: "assistant", content: "parent-history-sentinel" },
    ]);
    store.planSubagents(task.id, [plan("prior", "explorer")]);
    store.updateSubagent(
      task.id,
      "prior",
      "completed",
      [{ role: "assistant", content: "peer-context-sentinel" }],
      "peer-report-sentinel",
    );

    const started = new Set<string>();
    const traces: unknown[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new SubagentCoordinator({
      taskId: task.id,
      workspace: root,
      storage: store,
      limits: new SubagentLimits(),
      signal: new AbortController().signal,
      trace: (...args) => {
        traces.push(args);
      },
      provider: {
        async run(input, _instructions, tools) {
          const content = String(input[0].content);
          const id = content.includes("Inspect a") ? "a" : "b";
          const sibling = id === "a" ? "b" : "a";
          expect(JSON.stringify(input)).not.toMatch(
            /parent-history-sentinel|peer-context-sentinel|peer-report-sentinel/,
          );
          expect(tools.map(({ name }) => name)).toEqual([
            "read_file",
            "list_entries",
            "search_text",
            "ask_main",
          ]);

          if (!input.some((item) => item.type === "function_call_output")) {
            expect(input).toHaveLength(1);
            started.add(id);
            await barrier;

            return {
              text: "",
              output: [id, sibling].map((target) => ({
                type: "function_call",
                call_id: `read-${target}`,
                name: "read_file",
                arguments: JSON.stringify({
                  execution: { id: `read-${target}`, dependsOn: [] },
                  arguments: {
                    path: `src/${target}/value.ts`,
                    startLine: 1,
                    endLine: 1,
                  },
                }),
              })),
            };
          }

          const outputs = input.filter(
            (item) => item.type === "function_call_output",
          );
          expect(outputs).toHaveLength(2);
          expect(String(outputs[0].output)).toContain(`evidence-${id}`);
          expect(JSON.parse(String(outputs[1].output))).toHaveProperty("error");
          expect(JSON.stringify(input)).not.toContain(`evidence-${sibling}`);

          return {
            output: [],
            text: `Verified src/${id}/value.ts:1; cross-scope evidence unavailable`,
          };
        },
      },
    });

    try {
      await coordinator.execute({
        action: "plan",
        subtasks: [plan("a", firstRole), plan("b", secondRole)].map((item) => ({
          ...item,
          dependsOn: ["prior"],
        })),
      });
      await expect.poll(() => started.size, { timeout: 15_000 }).toBe(2);
      release();
      await expect(
        coordinator.execute({
          action: "await",
          subagentIds: ["a", "b"],
          timeoutMs: 15_000,
        }),
      ).resolves.toMatchObject({
        subtasks: [
          { id: "a", status: "completed" },
          { id: "b", status: "completed" },
        ],
      });
      await expect(
        coordinator.execute({ action: "collect", subagentIds: ["a", "b"] }),
      ).resolves.toMatchObject({
        reports: [
          {
            id: "a",
            report:
              "Verified src/a/value.ts:1; cross-scope evidence unavailable",
          },
          {
            id: "b",
            report:
              "Verified src/b/value.ts:1; cross-scope evidence unavailable",
          },
        ],
      });
      expect(
        store
          .subagents(task.id)
          .slice(1)
          .map((item) => item.plan.role),
      ).toEqual([firstRole, secondRole]);
      expect(traces).toEqual(
        expect.arrayContaining([
          ["subagent.worker", "a", "completed", expect.any(Number)],
          ["subagent.worker", "b", "completed", expect.any(Number)],
        ]),
      );
      expect(JSON.stringify(traces)).not.toMatch(
        /evidence-|baseline value|sentinel/,
      );
    } finally {
      release();
      await coordinator.close();
      await store.closeAsync();
    }
  },
  45_000,
);
