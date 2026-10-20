/**
 * 将模型 function_call 转为共用工具图，并统一判断执行结果是否允许后继节点继续。
 * Engine 和 AgentRuntimeService 调用本模块；这里只解析数据，不执行工具或持久化事件。
 *
 * 1. ModelToolCall 描述计划所需的模型字段，buildModelToolGraph 复用工具及历史读取参数校验，按任务开关验证 subagent 协调调用，再交给 createToolGraph 验证依赖。
 * 2. Git CLI 与其他命令一样只按显式 DAG 依赖调度，不识别命令文本或提供 push 专属独占。
 * 3. serializeToolOutput 按原始 JSON 字符数截断模型反馈；只处理序列化，脱敏及报告消费判定仍留在入口。
 * 4. toolSucceeded 同时检查工具错误、平面及 Git 写入嵌套退出码和多文件 failed/unknown，供 DAG、日志和 tracing 使用同一结论。
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
  options: { subagentsEnabled?: boolean } = {},
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

  return createToolGraph(nodes);
}

export function serializeToolOutput(result: unknown, outputChars: number) {
  const serialized = JSON.stringify(result);
  const complete = serialized.length <= outputChars;
  const output = complete
    ? serialized
    : JSON.stringify({
        truncated: true,
        text: serialized.slice(0, outputChars),
      });

  return { output, complete };
}

export function toolSucceeded(result: any) {
  const gitWriteFailed =
    (result?.add && result.add.exitCode !== 0) ||
    (result?.stage && result.stage.exitCode !== 0) ||
    (result?.commit && result.commit.exitCode !== 0);

  return (
    !result?.error &&
    !gitWriteFailed &&
    (result?.exitCode === undefined || result.exitCode === 0) &&
    !result?.files?.some(
      (file: any) => file.status === "failed" || file.status === "unknown",
    )
  );
}
