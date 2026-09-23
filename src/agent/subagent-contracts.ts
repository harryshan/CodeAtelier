/*
 * 定义主 agent 分工工具和任务内子任务计划的纯契约，供宿主、Runtime 与 Worker 消息分派共用。
 *
 * 1. subagentActionSchema 验证主角色的 plan/message/await/collect/cancel 请求和文本上限。
 * 2. validateSubagentPlan 在任何 Worker 启动前检查 ID、依赖图和累计计划上限；路径的规范化
 *    与实际读取权限由协调器在工作区上下文中另外校验。
 * 3. subagentToolDefinition 带工具 DAG 的 execution 信封，只供已启用任务按条件追加；它本身不是写入权限或执行器。
 *
 * 本模块无 I/O，不访问 SQLite 或进程能力。模型生成的计划始终是不可信输入。
 */

import { z } from "zod";
import { scheduledParameters } from "../tools/registry.js";

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const subtaskSchema = z
  .object({
    id: identifier,
    role: z.string().trim().min(1).max(80),
    objective: z.string().trim().min(1).max(1_000),
    scope: z.array(z.string().min(1).max(1_024)).min(1).max(8),
    dependsOn: z.array(identifier).max(4),
    deliverable: z.string().trim().min(1).max(500),
  })
  .strict();

export const subagentActionSchema = z
  .object({
    request: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("plan"),
          subtasks: z.array(subtaskSchema).min(1).max(4),
        })
        .strict(),
      z
        .object({
          action: z.literal("message"),
          subagentId: identifier,
          text: z.string().min(1).max(2_000),
        })
        .strict(),
      z
        .object({
          action: z.literal("await"),
          subagentIds: z.array(identifier).min(1).max(4),
          timeoutMs: z.number().int().min(100).max(30_000),
        })
        .strict(),
      z
        .object({
          action: z.literal("collect"),
          subagentIds: z.array(identifier).min(1).max(4),
        })
        .strict(),
      z
        .object({ action: z.literal("cancel"), subagentId: identifier })
        .strict(),
    ]),
  })
  .strict();

export type SubtaskPlan = z.infer<typeof subtaskSchema>;
export type SubagentAction = z.infer<typeof subagentActionSchema>["request"];

export function validateSubagentPlan(
  subtasks: SubtaskPlan[],
  existingIds: ReadonlySet<string> = new Set(),
) {
  const checked = z.array(subtaskSchema).min(1).max(4).parse(subtasks);
  const ids = new Set(existingIds);
  if (checked.length + existingIds.size > 4) {
    throw new Error("每任务累计最多创建四个 subagent。");
  }

  for (const subtask of checked) {
    if (ids.has(subtask.id)) {
      throw new Error("subagent ID 重复。");
    }

    ids.add(subtask.id);
  }

  const pending = new Map(checked.map((subtask) => [subtask.id, subtask]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) {
      throw new Error("subagent 计划包含循环依赖。");
    }

    if (visited.has(id) || existingIds.has(id)) {
      return;
    }

    const subtask = pending.get(id);
    if (!subtask) {
      throw new Error("subagent 依赖不属于当前任务。");
    }

    visiting.add(id);
    for (const parent of subtask.dependsOn) {
      visit(parent);
    }

    visiting.delete(id);
    visited.add(id);
  };

  for (const subtask of checked) {
    visit(subtask.id);
  }

  return checked;
}

export const subagentToolDefinition = {
  type: "function" as const,
  name: "subagent",
  description:
    "Coordinate read-only subagents in this task. Only the main agent can plan, message, await, collect or cancel them. All edits and verification stay with the main agent.",
  parameters: z.toJSONSchema(scheduledParameters(subagentActionSchema)),
  strict: true,
};
