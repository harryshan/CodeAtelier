/**
 * 文件作用：集中定义模型连接、执行限制和日志设置的校验契约。
 * 代码结构：settingsSchema 按配置字段声明类型、取值范围与兼容默认值，供配置加载和更新共用。
 */

import { z } from "zod";

export const settingsSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
  model: z.string().min(1).max(200),
  reasoningEffort: z.enum(["low", "medium", "high"]).default("high"),
  maxSteps: z.number().int().min(1).max(100),
  commandTimeoutMs: z.number().int().min(1000).max(600000),
  requestTimeoutMs: z.number().int().min(1000).max(600000),
  idleTimeoutMs: z.number().int().min(1000).max(300000),
  maxOutputTokens: z.number().int().min(1).max(2000000).default(16384),
  contextChars: z.number().int().min(10000).max(2000000),
  outputChars: z.number().int().min(1000).max(100000),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
});
