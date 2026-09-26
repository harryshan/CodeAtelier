/*
 * 声明 subagent 自有模型 loop 可见的只读工具协议，供 Worker 声明和父进程执行器共享。
 *
 * 1. subagentReadSchemas 校验读取范围、非空搜索文本和调用方选择的结果数量，不附加子任务专属数量上限。
 * 2. subagentReadDefinitions 为模型附带调度信封，只暴露这三个白名单工具。
 * 3. parseSubagentReadCall 校验模型输出和无依赖执行元数据；父进程仍须再次校验。
 *
 * 不导入 Node 文件系统、shell、Git 或写入能力；模型输入仍是非可信数据。
 */

import { z } from "zod";
import { scheduledParameters } from "../tools/registry.js";

export const subagentReadSchemas = {
  read_file: z
    .object({
      path: z.string().min(1),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    })
    .strict(),
  list_entries: z
    .object({
      path: z.string().min(1),
      maxEntries: z.number().int().min(1),
    })
    .strict(),
  search_text: z
    .object({
      path: z.string().min(1),
      pattern: z.string().min(1),
      maxMatches: z.number().int().min(1),
    })
    .strict(),
};

export type SubagentReadName = keyof typeof subagentReadSchemas;

export const subagentReadDefinitions = Object.entries(subagentReadSchemas).map(
  ([name, parameters]) => ({
    type: "function" as const,
    name,
    description: `Read-only workspace ${name}; no shell, edits, Git, network, memory or approval capabilities.`,
    parameters: z.toJSONSchema(scheduledParameters(parameters)),
    strict: true,
  }),
);

export function parseSubagentReadCall(name: string, raw: unknown) {
  if (!Object.hasOwn(subagentReadSchemas, name)) {
    throw new Error("subagent 仅允许只读工具。");
  }

  const schema = subagentReadSchemas[name as SubagentReadName];
  const parsed = scheduledParameters(schema).parse(raw);
  if (parsed.execution.dependsOn.length) {
    throw new Error("subagent 工具必须按单独的顺序调用。");
  }

  return parsed;
}
