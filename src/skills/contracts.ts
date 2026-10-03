/**
 * 定义主 agent 的 Skill 只读工具协议；registry、ToolRunner 和 Runtime IPC 共用同一校验。
 * 1. skillNameSchema 限制可调用名称，调用方不能传文件路径或命令。
 * 2. skillActionSchema 提供 list/load，skillToolSchema 用 request 包装以适配 strict 模型工具。
 * 3. SkillSummary/SkillResult 是后端返回的目录摘要和按需正文；执行归因不表示 Sandbox 文件授权。
 * 本文件无文件访问或状态；第三方元信息不会成为动态工具 schema 或权限配置。
 */
import { z } from "zod";

export const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const skillActionSchema = z.union([
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("load"), name: skillNameSchema }).strict(),
]);

export const skillToolSchema = z
  .object({ request: skillActionSchema })
  .strict();

export type SkillAction = z.infer<typeof skillActionSchema>;

export interface SkillSummary {
  name: string;
  description: string;
  source: string;
  directory: string;
  file: string;
  contentHash: string;
}

export interface SkillResult {
  execution: { kind: "broker-skill"; mode: "host-process" };
  skills?: SkillSummary[];
  diagnostics?: { source: string; name?: string; code: string }[];
  skill?: SkillSummary;
  content?: string;
  notice?: string;
}
