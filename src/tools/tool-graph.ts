/**
 * 将同一模型响应中的工具调用校验为 DAG，并按拓扑关系有界并发调度。
 * Engine 负责把 Responses 的 function_call 转为 ToolGraphNode、持久化事件和执行真实工具；本模块
 * 不访问文件、数据库、权限或模型，因此可独立验证图结构和失败传播。
 *
 * 1. createToolGraph 校验节点 ID、依赖引用及环，保留模型原始顺序作为稳定调度优先级。
 * 2. executeToolGraph 使用 Kahn 入度算法：所有前置成功的节点才进入 ready 队列，最多同时运行
 *    maxConcurrency 个节点；每个运行节点同时获得一个可复用的稳定并发槽位，供调用方合并性能轨道。
 * 3. 前置失败时 blockDescendants 会递归阻断所有后继节点；被阻断节点不会调用 execute，避免把失败或
 *    未知副作用当成可继续使用的前置条件。
 *
 * 并发只由调用图决定，不在这里推断文件或命令资源冲突。工具执行器仍必须自行完成路径、快照、
 * 权限和并发变化校验；调用方应将每个节点的状态和结果及时持久化，避免崩溃后重放副作用。
 */

export interface ToolGraphNode {
  callId: string;
  nodeId: string;
  name: string;
  arguments: unknown;
  dependsOn: string[];
  ordinal: number;
}

export interface ToolGraph {
  nodes: ToolGraphNode[];
  successors: Map<string, string[]>;
}

export type ToolGraphNodeState =
  | "waiting_dependencies"
  | "queued"
  | "executing"
  | "succeeded"
  | "failed"
  | "blocked";

export const MAX_TOOL_GRAPH_NODES = 20;
export const DEFAULT_TOOL_CONCURRENCY = 4;

/** 结构错误必须在任何节点执行前发现，避免只执行模型计划的一部分。 */
export function createToolGraph(nodes: ToolGraphNode[]): ToolGraph {
  if (!nodes.length) {
    throw new Error("工具调用图不能为空。");
  }

  if (nodes.length > MAX_TOOL_GRAPH_NODES) {
    throw new Error(`单次工具调用最多 ${MAX_TOOL_GRAPH_NODES} 项。`);
  }

  const byId = new Map<string, ToolGraphNode>();
  const successors = new Map<string, string[]>();

  for (const node of nodes) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(node.nodeId)) {
      throw new Error(`工具节点 ID 无效：${node.nodeId}`);
    }

    if (byId.has(node.nodeId)) {
      throw new Error(`工具节点 ID 重复：${node.nodeId}`);
    }

    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new Error(`工具节点 ${node.nodeId} 包含重复依赖。`);
    }

    if (node.dependsOn.includes(node.nodeId)) {
      throw new Error(`工具节点 ${node.nodeId} 不能依赖自身。`);
    }

    byId.set(node.nodeId, node);
    successors.set(node.nodeId, []);
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `工具节点 ${node.nodeId} 依赖不存在的节点：${dependency}`,
        );
      }

      successors.get(dependency)!.push(node.nodeId);
    }
  }

  const indegrees = new Map(
    nodes.map((node) => [node.nodeId, node.dependsOn.length]),
  );
  const ready = nodes
    .filter((node) => indegrees.get(node.nodeId) === 0)
    .sort((left, right) => left.ordinal - right.ordinal);
  let visited = 0;

  while (ready.length) {
    const node = ready.shift()!;
    visited++;

    for (const successor of successors.get(node.nodeId)!) {
      const remaining = indegrees.get(successor)! - 1;
      indegrees.set(successor, remaining);
      if (remaining === 0) {
        ready.push(byId.get(successor)!);
        ready.sort((left, right) => left.ordinal - right.ordinal);
      }
    }
  }

  if (visited !== nodes.length) {
    throw new Error("工具调用图不能包含循环依赖。");
  }

  return { nodes, successors };
}

export async function executeToolGraph(
  graph: ToolGraph,
  options: {
    maxConcurrency?: number;
    execute: (node: ToolGraphNode, slot: number) => Promise<boolean>;
    block: (
      node: ToolGraphNode,
      failedDependency: ToolGraphNode,
    ) => Promise<void>;
    state?: (node: ToolGraphNode, state: ToolGraphNodeState) => void;
  },
) {
  const byId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const remaining = new Map(
    graph.nodes.map((node) => [node.nodeId, node.dependsOn.length]),
  );
  const states = new Map<string, ToolGraphNodeState>();
  const ready = graph.nodes
    .filter((node) => node.dependsOn.length === 0)
    .sort((left, right) => left.ordinal - right.ordinal);
  const active = new Map<
    string,
    Promise<{ node: ToolGraphNode; slot: number; succeeded: boolean }>
  >();
  const maxConcurrency = Math.max(
    1,
    Math.min(
      options.maxConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
      graph.nodes.length,
    ),
  );
  const availableSlots = Array.from(
    { length: maxConcurrency },
    (_, index) => index,
  );

  const update = (node: ToolGraphNode, state: ToolGraphNodeState) => {
    states.set(node.nodeId, state);
    options.state?.(node, state);
  };

  const enqueue = (node: ToolGraphNode) => {
    ready.push(node);
    ready.sort((left, right) => left.ordinal - right.ordinal);
    update(node, "queued");
  };

  const blockDescendants = async (
    failed: ToolGraphNode,
    nodeId: string,
  ): Promise<void> => {
    const node = byId.get(nodeId)!;
    const current = states.get(nodeId);
    if (
      current === "blocked" ||
      current === "succeeded" ||
      current === "failed"
    ) {
      return;
    }

    update(node, "blocked");
    await options.block(node, failed);

    for (const successor of graph.successors.get(nodeId)!) {
      await blockDescendants(failed, successor);
    }
  };

  for (const node of graph.nodes) {
    update(node, node.dependsOn.length ? "waiting_dependencies" : "queued");
  }

  while (active.size || ready.length) {
    while (active.size < maxConcurrency && ready.length) {
      const node = ready.shift()!;
      if (states.get(node.nodeId) === "blocked") {
        continue;
      }

      const slot = availableSlots.shift()!;
      update(node, "executing");
      const execution = options
        .execute(node, slot)
        .then((succeeded) => ({ node, slot, succeeded }));
      active.set(node.nodeId, execution);
    }

    const completed = await Promise.race(active.values());
    active.delete(completed.node.nodeId);
    availableSlots.push(completed.slot);
    availableSlots.sort((left, right) => left - right);

    if (!completed.succeeded) {
      update(completed.node, "failed");
      for (const successor of graph.successors.get(completed.node.nodeId)!) {
        await blockDescendants(completed.node, successor);
      }

      continue;
    }

    update(completed.node, "succeeded");
    for (const successor of graph.successors.get(completed.node.nodeId)!) {
      if (states.get(successor) === "blocked") {
        continue;
      }

      const count = remaining.get(successor)! - 1;
      remaining.set(successor, count);
      if (count === 0) {
        enqueue(byId.get(successor)!);
      }
    }
  }

  return states;
}
