/**
 * 用 Zod 校验后端设置，Config 在启动和更新配置时都会使用这里的规则。
 * 校验后的设置通过共享的 Settings 类型传递给其他模块。
 *
 * 1. connectionSettingsSchema 校验旧环境迁移的主/辅助协议、API 地址和模型标识。
 * 2. persistedSettingsSchema 保留旧偏好校验，同时为 v1 文档复用执行限制范围。
 * 3. settingsSchema 将字段合成为运行时 Settings；版本化磁盘/API schema 位于 settings-document.ts。
 *
 * 新产品启动只读取版本化文件；此处旧结构用于兼容迁移与已有运行时调用方。
 * 通过校验仅表示格式合法，不证明服务支持对应能力。
 */

import { z } from "zod";

export const modelProtocolSchema = z.enum([
  "responses",
  "chat-completions",
  "messages",
]);

export const connectionSettingsSchema = z.object({
  protocol: modelProtocolSchema.default("responses"),
  auxiliaryProtocol: modelProtocolSchema.optional(),
  auxiliaryBaseUrl: z
    .string()
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol))
    .optional(),
  baseUrl: z
    .string()
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
  model: z.string().trim().min(1).max(200),
  auxiliaryModel: z.string().trim().max(200).default(""),
});

export const persistedSettingsSchema = z.object({
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).default("high"),
  auxiliaryReasoningEffort: z
    .enum(["none", "low", "medium", "high"])
    .default("low"),
  maxSteps: z.number().int().min(1).max(100),
  // 兼容旧偏好、v1 文档与 API；0 表示已取消主任务上限，旧值不能恢复限制。
  maxConcurrentTasks: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .transform(() => 0),
  // 兼容旧 settings.json/API 字段，但不再让历史偏好恢复命令运行时限。
  commandTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .transform(() => 0),
  requestTimeoutMs: z.number().int().min(1000).max(600000),
  idleTimeoutMs: z.number().int().min(1000).max(300000),
  maxOutputTokens: z.number().int().min(1).max(2000000).default(16384),
  maxContextTokens: z.number().int().min(4096).max(2000000).default(300000),
  contextChars: z.number().int().min(10000).max(2000000),
  outputChars: z.number().int().min(1000).max(100000),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
});

export const settingsSchema = connectionSettingsSchema.extend(
  persistedSettingsSchema.shape,
);
