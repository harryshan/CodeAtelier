/**
 * 验证工具调用图的纯调度行为，不启动模型、文件系统、命令或审批服务。
 * 工具图调度器由 Engine 调用，本文件以可控异步回调检查拓扑并发、失败阻断和结构拒绝。
 *
 * 1. 分叉后的根节点应在同一并发窗口启动并占用不同的可复用并发槽位，汇聚节点仅在全部前置成功后执行。
 * 2. 前置失败会阻断全部后继，但不影响没有依赖关系的节点。
 * 3. 重复 ID、未知依赖和环必须在执行回调前拒绝，避免无效计划产生副作用。
 *
 * 这些测试只观察调度器对调用方的状态和回调，不重复测试 ToolRunner 的路径、权限或文件快照校验。
 */

import { expect, it } from "vitest";
import {
  createToolGraph,
  executeToolGraph,
  type ToolGraphNode,
} from "../src/tools/tool-graph.js";

function node(
  nodeId: string,
  dependsOn: string[] = [],
  ordinal = 0,
): ToolGraphNode {
  return {
    callId: `call-${nodeId}`,
    nodeId,
    name: "read_file",
    arguments: {},
    dependsOn,
    ordinal,
  };
}

it("runs independent nodes concurrently and starts a join only after all dependencies succeed", async () => {
  const graph = createToolGraph([
    node("first", [], 0),
    node("second", [], 1),
    node("join", ["first", "second"], 2),
  ]);
  const started: string[] = [];
  const finished: string[] = [];
  const slots = new Map<string, number>();
  let active = 0;
  let maximumActive = 0;

  await executeToolGraph(graph, {
    maxConcurrency: 2,
    async execute(current, slot) {
      started.push(current.nodeId);
      slots.set(current.nodeId, slot);
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      finished.push(current.nodeId);

      return true;
    },
    async block() {
      throw new Error("成功分支不应阻断节点。");
    },
  });

  expect(started.slice(0, 2)).toEqual(["first", "second"]);
  expect(new Set([slots.get("first"), slots.get("second")]).size).toBe(2);
  expect([...slots.values()].every((slot) => slot >= 0 && slot < 2)).toBe(true);
  expect(maximumActive).toBe(2);
  expect(started[2]).toBe("join");
  expect(finished).toContain("first");
  expect(finished).toContain("second");
});

it("blocks descendants after a failed dependency while retaining independent execution", async () => {
  const graph = createToolGraph([
    node("fails", [], 0),
    node("independent", [], 1),
    node("blocked", ["fails"], 2),
  ]);
  const executed: string[] = [];
  const blocked: string[] = [];

  const states = await executeToolGraph(graph, {
    maxConcurrency: 2,
    async execute(current) {
      executed.push(current.nodeId);

      return current.nodeId !== "fails";
    },
    async block(current, failedDependency) {
      blocked.push(`${current.nodeId}:${failedDependency.nodeId}`);
    },
  });

  expect(executed).toEqual(expect.arrayContaining(["fails", "independent"]));
  expect(executed).not.toContain("blocked");
  expect(blocked).toEqual(["blocked:fails"]);
  expect(states.get("fails")).toBe("failed");
  expect(states.get("independent")).toBe("succeeded");
  expect(states.get("blocked")).toBe("blocked");
});

it.each([
  ["duplicate ID", [node("same"), node("same", [], 1)]],
  ["unknown dependency", [node("first"), node("second", ["missing"], 1)]],
  ["cycle", [node("first", ["second"]), node("second", ["first"], 1)]],
] as const)("rejects a graph with %s before scheduling", (_name, nodes) => {
  expect(() => createToolGraph([...nodes])).toThrow();
});
