/**
 * 宿主 Engine 与 Sandbox AgentRuntimeService 共用的单节点工具分派，不承担 DAG 调度或结果保存。
 *
 * 1. ModelToolDispatch 接收已校验节点所需的 runner、子任务入口、历史读取和执行槽回调；不创建任何宿主能力。
 * 2. dispatchModelTool 验证 subagent 开关与操作，普通操作先取得执行槽，await 则等待后才取得槽。
 *    afterSubagentWait 由环境注入：宿主保留执行计时，Runtime 仅取得槽，不能把等待误记为执行耗时。
 * 3. 历史读取先取得槽；普通工具沿用 forCall 的关联身份与审批后 startExecution，只有 read_file 接收阶段 trace。
 *    错误/取消原样传播，由入口沿用各自脱敏、日志、trace 收尾和持久化规则；不增加重试或权限。
 */

import { historyDefinition } from "../context/history.js";
import type { SubagentAction } from "../agent/subagent-contracts.js";
import type { ToolGraphNode } from "./tool-graph.js";
import type { ToolRunner } from "./tool-runner.js";
import type { ReadFileTrace } from "./read-file-content.js";

interface ModelToolDispatch {
  subagentsEnabled: boolean;
  subagents?: { execute(action: SubagentAction): Promise<unknown> };
  runner: { forCall(callId: string): Pick<ToolRunner, "execute"> };
  startExecution(): Promise<void>;
  afterSubagentWait(): Promise<unknown>;
  readHistory(arguments_: unknown): Promise<unknown>;
  traceReadFile?: ReadFileTrace;
}

export async function dispatchModelTool(
  node: ToolGraphNode,
  operations: ModelToolDispatch,
): Promise<unknown> {
  if (node.name === "subagent") {
    if (!operations.subagentsEnabled || !operations.subagents) {
      throw new Error("当前任务未开启 subagent。");
    }

    const action = (node.arguments as { request?: SubagentAction }).request;
    if (!action) {
      throw new Error("subagent 缺少结构化操作。");
    }

    if (action.action !== "await") {
      await operations.startExecution();
    }

    const result = await operations.subagents.execute(action);
    if (action.action === "await") {
      await operations.afterSubagentWait();
    }

    return result;
  }

  if (node.name === historyDefinition.name) {
    await operations.startExecution();

    return operations.readHistory(node.arguments);
  }

  return operations.runner
    .forCall(node.callId)
    .execute(
      node.name,
      node.arguments,
      operations.startExecution,
      node.name === "read_file" ? operations.traceReadFile : undefined,
    );
}
