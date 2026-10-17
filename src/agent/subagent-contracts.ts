/*
 * 定义主 agent 分工工具和任务内子任务计划的纯契约，供宿主、Runtime 与 Worker 消息分派共用。
 *
 * 1. subtaskSchema 限定 explorer/reviewer 两种角色，reviewer 必须携带变更材料；subagentActionSchema 验证协调动作、replyTo 和非空文本。
 *    使用字面量互斥的普通联合生成模型支持的 anyOf；replyTo 无关联时为 null，旧调用省略时也归一化为 null。
 * 2. validateSubagentPlan 在任何 Worker 启动前检查 ID 唯一性与依赖图；路径的规范化
 *    与实际读取权限由协调器在工作区上下文中另外校验。
 * 3. subagentToolDefinition 带工具 DAG 的 execution 信封，只供已启用任务按条件追加；它本身不是写入权限或执行器。
 *
 * 本模块无 I/O，不访问 SQLite 或进程能力。模型生成的计划始终是不可信输入。
 */

import { z } from "zod";
import { scheduledParameters } from "../tools/registry.js";

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

const subtaskBaseSchema = z
  .object({
    id: identifier,
    objective: z.string().trim().min(1),
    scope: z.array(z.string().min(1)).min(1),
    dependsOn: z.array(identifier),
    deliverable: z.string().trim().min(1),
  })
  .strict();

// 两分支的 role 字面量互斥；普通 union 保留校验语义，避免生成 strict 模型不接受的 oneOf。
export const subtaskSchema = z.union([
  subtaskBaseSchema.extend({ role: z.literal("explorer") }),
  subtaskBaseSchema.extend({
    role: z.literal("reviewer"),
    changes: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Scoped diff or before/after change material with file paths and baseline/version. Supply evidence, not the main agent's conversation or conclusions.",
      ),
  }),
]);

export const subagentActionSchema = z
  .object({
    request: z.union([
      z
        .object({
          action: z.literal("plan"),
          subtasks: z.array(subtaskSchema).min(1),
        })
        .strict(),
      z
        .object({
          action: z.literal("message"),
          subagentId: identifier,
          text: z.string().min(1),
          replyTo: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .nullable()
            .default(null),
        })
        .strict(),
      z
        .object({
          action: z.literal("await"),
          subagentIds: z.array(identifier).min(1),
          timeoutMs: z.number().int().min(100).max(30_000),
        })
        .strict(),
      z
        .object({
          action: z.literal("collect"),
          subagentIds: z.array(identifier).min(1),
        })
        .strict(),
      z
        .object({ action: z.literal("cancel"), subagentId: identifier })
        .strict(),
    ]),
  })
  .strict();

export type SubtaskPlan = z.infer<typeof subtaskSchema>;
// 协调器接受输入类型以兼容历史省略 replyTo 的调用，执行前仍经过 schema 归一化。
export type SubagentAction = z.input<typeof subagentActionSchema>["request"];

export function validateSubagentPlan(
  subtasks: SubtaskPlan[],
  existingIds: ReadonlySet<string> = new Set(),
) {
  const checked = z.array(subtaskSchema).min(1).parse(subtasks);
  const ids = new Set(existingIds);

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
    "Coordinate built-in read-only subagents: explorer gathers and filters relevant information with evidence; reviewer independently reviews your changes in a fresh context. Supply reviewer changes as a scoped diff or before/after material, with paths and baseline/version. Both roles support multiple instances with separate IDs and scopes, running concurrently within shared Worker limits; use dependencies only when necessary. No parent conversation or peer reports are inherited. Children can ask questions; await may return early. Answer using message with replyTo set to the question ID; use null for an unlinked message. Collect reports and verify evidence yourself. All edits and command-based verification stay with the main agent.",
  parameters: z.toJSONSchema(scheduledParameters(subagentActionSchema)),
  strict: true,
};
