/**
 * 验证模型工具计划与结果判定的共享规则，不执行命令或访问磁盘。
 *
 * 1. 用真实参数 schema 构造宿主/Runtime 工具图，确认节点与依赖一致，Git CLI 不增加隐式独占或调度分支。
 * 2. 验证 subagent 调用只在本任务开启后通过结构化图解析，宿主与 Runtime 共用同一拒绝规则。
 * 3. 用真实 DAG 调度器和失败结果验证失败/unknown 文件、平面及 Git 写入嵌套非零退出会阻断后继，而成功结果允许继续。
 */

import { expect, it } from "vitest";
import {
  buildModelToolGraph,
  toolSucceeded,
} from "../src/tools/model-tool-batch.js";
import { executeToolGraph } from "../src/tools/tool-graph.js";

function call(id: string, dependsOn: string[] = []) {
  return {
    call_id: `${id}-call`,
    name: "read_file",
    arguments: JSON.stringify({
      execution: { id, dependsOn },
      arguments: { path: "sample.txt", startLine: 1, endLine: 1 },
    }),
  };
}

it("builds the same ordered dependency graph in both execution modes", () => {
  const calls = [call("first"), call("second", ["first"])];
  const graph = buildModelToolGraph(calls);

  expect(graph.nodes[1]).toEqual({
    callId: "second-call",
    nodeId: "second",
    name: "read_file",
    arguments: {
      path: "sample.txt",
      startLine: 1,
      endLine: 1,
      whitespaceMode: false,
    },
    dependsOn: ["first"],
    ordinal: 1,
  });
});

it.each(["run_command", "run_with_permissions"])(
  "schedules Git CLI through %s using only explicit dependencies",
  (name) => {
    const push = {
      call_id: "push",
      name,
      arguments: JSON.stringify({
        execution: { id: "push", dependsOn: ["read"] },
        arguments: {
          command: "git push origin HEAD",
          ...(name === "run_with_permissions"
            ? { reason: "需要宿主凭据。" }
            : {}),
        },
      }),
    };
    const graph = buildModelToolGraph([
      call("read"),
      push,
      call("independent"),
    ]);

    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes[1]).toMatchObject({ name, dependsOn: ["read"] });
    expect(graph.nodes[2].dependsOn).toEqual([]);
  },
);

it("does not parse subagent calls for unselected tasks in either execution mode", () => {
  const coordination = {
    call_id: "plan-call",
    name: "subagent",
    arguments: JSON.stringify({
      execution: { id: "plan", dependsOn: [] },
      arguments: {
        request: {
          action: "plan",
          subtasks: [
            {
              id: "review",
              role: "reviewer",
              changes: "src/example.ts: baseline value = 1; current value = 2",
              objective: "inspect",
              scope: ["src"],
              dependsOn: [],
              deliverable: "report",
            },
          ],
        },
      },
    }),
  };

  expect(() => buildModelToolGraph([coordination])).toThrow("未开启 subagent");
  expect(
    buildModelToolGraph([coordination], { subagentsEnabled: true }).nodes[0],
  ).toMatchObject({
    name: "subagent",
    nodeId: "plan",
    arguments: { request: { action: "plan" } },
  });

  expect(() =>
    buildModelToolGraph(
      [
        {
          ...coordination,
          arguments: JSON.stringify({
            execution: { id: "plan", dependsOn: [] },
            arguments: {
              request: {
                action: "cancel",
                subagentId: "review",
                command: "write",
              },
            },
          }),
        },
      ],
      { subagentsEnabled: true },
    ),
  ).toThrow();
});

it.each([
  [{ error: "failed" }, false],
  [{ exitCode: 1 }, false],
  [{ exitCode: null }, false],
  [{ paths: ["change.txt"], add: { exitCode: 1 } }, false],
  [
    { paths: ["change.txt"], stage: { exitCode: 0 }, commit: { exitCode: 1 } },
    false,
  ],
  [{ files: [{ status: "failed" }] }, false],
  [{ files: [{ status: "unknown" }] }, false],
  [{ exitCode: 0 }, true],
  [{ files: [{ status: "written" }] }, true],
] as const)(
  "propagates result %j through DAG dependencies",
  async (result, succeeded) => {
    const graph = buildModelToolGraph([
      call("first"),
      call("second", ["first"]),
    ]);
    const visited: string[] = [];

    await executeToolGraph(graph, {
      async execute(node, acquireExecutionSlot) {
        await acquireExecutionSlot();
        visited.push(node.nodeId);

        return toolSucceeded(result);
      },
      async block(node) {
        visited.push(`blocked:${node.nodeId}`);
      },
    });

    expect(visited).toEqual(["first", succeeded ? "second" : "blocked:second"]);
  },
);
