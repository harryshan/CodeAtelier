/*
 * 声明子模型向主协调器提问的唯一非文件操作，供 Worker 与父进程共享安全边界。
 *
 * 1. askMainArguments 只接受一段有界问题，不指定收件 Worker、目录、命令或额外权限。
 * 2. askMainDefinition 与三个文件读取工具并列提供给子模型；主协调器单独处理消息，不交给文件工具执行器。
 * 3. parseAskMainCall 校验无依赖的调度信封；父进程还会复核归属、数量和持久化结果。
 *
 * 发问不写工作区，也不让子线程访问 Broker、主模型或另一子线程；数据库事件仅由可信协调器保存。
 */

import { z } from "zod";
import { scheduledParameters } from "../tools/registry.js";
import { subagentReadDefinitions } from "./subagent-read-contract.js";

export const askMainArguments = z
  .object({ question: z.string().trim().min(1).max(1_000) })
  .strict();

export const askMainDefinition = {
  type: "function" as const,
  name: "ask_main",
  description:
    "Ask the main coordinator one bounded question. This only sends a message; it cannot edit files, run commands, contact peers directly or grant permissions. Do not wait for an answer; continue independent reading.",
  parameters: z.toJSONSchema(scheduledParameters(askMainArguments)),
  strict: true,
};

export const subagentToolDefinitions = [
  ...subagentReadDefinitions,
  askMainDefinition,
];

export function parseAskMainCall(raw: unknown) {
  const parsed = scheduledParameters(askMainArguments).parse(raw);
  if (parsed.execution.dependsOn.length) {
    throw new Error("subagent 问题不能依赖其它调用。");
  }

  return { ...parsed, arguments: askMainArguments.parse(parsed.arguments) };
}
