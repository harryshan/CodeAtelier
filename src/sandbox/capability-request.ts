/**
 * 定义 Agent Runtime 请求 Broker 审核并执行一次宿主命令的共享契约。
 * Tool registry、Runtime IPC 和 Broker executor 共用请求/结果 schema，避免跨进程参数漂移。
 *
 * 1. capabilityPermissionsSchema 保留暂停使用的 Capability Runner 原有权限形状，不进入当前工具请求。
 * 2. capabilityCommandRequestSchema 只绑定命令和理由；审批后的命令以 Broker 宿主权限执行。
 * 3. capabilityCommandResultSchema 返回有界进程结果与独立宿主 execution instance。
 *
 * 此工具没有额外的文件根或网络强制边界；不能再把旧权限声明当作执行限制。
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
