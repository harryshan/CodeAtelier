/**
 * 定义 Agent Runtime 请求一次性扩展权限命令的共享、严格契约。
 * Tool registry、Runtime IPC 和 Broker executor 共同使用这些 schema，避免模型参数、跨进程消息和实际授权范围漂移。
 *
 * 1. capabilityPermissionsSchema 只表达当前平台能够强制落实的递归文件根与单一 HTTPS host；空权限请求被拒绝。
 * 2. capabilityCommandRequestSchema 同时绑定命令、权限和人类可读理由，但理由只用于审批与审计，不能扩大权限。
 * 3. capabilityCommandResultSchema 返回有界进程结果和独立 execution instance；unknown/orphaned 不会伪装成普通结果。
 *
 * 文件根授权是递归目录能力，不是单文件补丁语义。Broker 必须重新规范化路径、请求用户审批并通过
 * AccessManifest/relay 落实；绝不能因为 Runtime 已发送该对象就认为它已获授权。
 */

import { z } from "zod";

const rootPath = z.string().trim().min(1).max(32_767);
const httpsHost = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/)
  .refine(
    (value) =>
      !value.startsWith(".") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      value
        .split(".")
        .every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            !label.startsWith("-") &&
            !label.endsWith("-"),
        ),
    "HTTPS host 必须是规范的 DNS 名称或 IPv4 地址。",
  );

export const capabilityPermissionsSchema = z
  .object({
    readRoots: z.array(rootPath).max(16),
    writeRoots: z.array(rootPath).max(16),
    httpsHost: httpsHost.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.readRoots.length > 0 ||
      value.writeRoots.length > 0 ||
      value.httpsHost !== null,
    "至少声明一项扩展权限。",
  );

export const capabilityCommandRequestSchema = z
  .object({
    command: z.string().trim().min(1).max(100_000),
    permissions: capabilityPermissionsSchema,
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

export type CapabilityPermissions = z.infer<typeof capabilityPermissionsSchema>;
export type CapabilityCommandRequest = z.infer<
  typeof capabilityCommandRequestSchema
>;
export type CapabilityCommandResult = z.infer<
  typeof capabilityCommandResultSchema
>;
