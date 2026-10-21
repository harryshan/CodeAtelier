/**
 * 定义 Agent Runtime 请求 Broker 审核并执行一次宿主命令的共享契约。
 * Tool registry、Runtime IPC 和 Broker executor 共用请求/结果 schema，避免跨进程参数漂移。
 *
 * 1. capabilityCommandRequestSchema 只绑定命令和理由；审批后的命令以 Broker 宿主权限执行。
 * 2. capabilityCommandResultSchema 返回有界进程结果与独立宿主 execution instance。
 * 3. 旧 Runner 权限声明已删除；strict schema 拒绝额外的根或网络授权字段。
 *
 * 此工具没有额外的文件根或网络强制边界；不能再把旧权限声明当作执行限制。
 */

import { z } from "zod";

export const capabilityCommandRequestSchema = z
  .object({
    command: z.string().trim().min(1).max(100_000),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const capabilityCommandResultSchema = z
  .object({
    executionInstanceId: z.string().min(1).max(120),
    output: z.string().max(2_000_000),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
  })
  .strict();

export type CapabilityCommandRequest = z.infer<
  typeof capabilityCommandRequestSchema
>;
export type CapabilityCommandResult = z.infer<
  typeof capabilityCommandResultSchema
>;
