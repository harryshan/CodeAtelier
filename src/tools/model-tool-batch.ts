/**
 * 将模型 function_call 转为共用工具图，并统一判断执行结果是否允许后继节点继续。
 * Engine 和 AgentRuntimeService 调用本模块；这里只解析数据，不执行工具或持久化事件。
 *
 * 1. ModelToolCall 描述计划所需的模型字段，buildModelToolGraph 复用工具及历史读取参数校验，按任务开关验证 subagent 协调调用，再交给 createToolGraph 验证依赖。
 * 2. exclusivePush 仅由 Runtime 入口启用，保留 Git push 审批与执行必须独占批次的规则，不改变宿主路径。
 * 3. toolSucceeded 同时检查工具错误、进程退出码和多文件 failed/unknown，供 DAG、日志和 tracing 使用同一结论。
 */

import {
  historyDefinition,
  parseScheduledHistoryArguments,
} from "../context/history.js";
import {
  parseScheduledToolArguments,
  scheduledParameters,
} from "./registry.js";
import { subagentActionSchema } from "../agent/subagent-contracts.js";
import { createToolGraph } from "./tool-graph.js";

export interface ModelToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

export function buildModelToolGraph(
  calls: ModelToolCall[],
  options: { exclusivePush: boolean; subagentsEnabled?: boolean },
) {
  const nodes = calls.map((call, ordinal) => {
    const raw = JSON.parse(call.arguments);
    if (call.name === "subagent" && !options.subagentsEnabled) {
      throw new Error("当前任务未开启 subagent，不能执行协调工具。");
    }

    const scheduled =
      call.name === "subagent"
        ? scheduledParameters(subagentActionSchema).parse(raw)
        : call.name === historyDefinition.name
          ? parseScheduledHistoryArguments(raw, `call-${ordinal + 1}`)
          : parseScheduledToolArguments(call.name, raw, `call-${ordinal + 1}`);

    return {
      callId: call.call_id,
      nodeId: scheduled.execution.id,
      name: call.name,
      arguments: scheduled.arguments,
      dependsOn: scheduled.execution.dependsOn,
      ordinal,
    };
  });
  if (options.exclusivePush) {
    const containsPush = nodes.some(
      (node) =>
        node.name === "git" &&
        ((node.arguments as any).action === "push" ||
          (node.arguments as any).request?.action === "push"),
    );
    if (containsPush && nodes.length !== 1) {
      throw new Error("Git push 必须是当前工具批次的唯一调用。");
    }
  }

  return createToolGraph(nodes);
}

export function toolSucceeded(result: any) {
  return (
    !result?.error &&
    (result?.exitCode === undefined || result.exitCode === 0) &&
    !result?.files?.some(
      (file: any) => file.status === "failed" || file.status === "unknown",
    )
  );
}
