/**
 * 文件作用：集中定义模型连接、执行限制和日志设置的校验契约。
 *
 * 模块协作与输入输出：
 * 被 Config 在初始化及更新时调用，为外部输入提供运行时校验；共享 Settings 类型用于跨模块传递。
 *
 * 代码结构与执行顺序：
 * 1. 连接字段描述 baseUrl、主模型与辅助模型及各自 reasoningEffort，兼容旧配置缺失的默认值。
 * 2. 执行字段限制步数、命令与模型超时，以及上下文、输出预算。
 * 3. 日志字段限定可用级别，整个对象由 Zod 解析后才交给运行时。
 *
 * 关键约束：
 * 新增设置须同步共享类型、配置入口和 UI；schema 约束不代表服务实际支持某项模型能力。
 */

import { z } from "zod";

export const settingsSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
  model: z.string().min(1).max(200),
  reasoningEffort: z.enum(["low", "medium", "high"]).default("high"),
  auxiliaryModel: z.string().trim().max(200).default(""),
  auxiliaryReasoningEffort: z.enum(["low", "medium", "high"]).default("low"),
  maxSteps: z.number().int().min(1).max(100),
  commandTimeoutMs: z.number().int().min(1000).max(600000),
  requestTimeoutMs: z.number().int().min(1000).max(600000),
  idleTimeoutMs: z.number().int().min(1000).max(300000),
  maxOutputTokens: z.number().int().min(1).max(2000000).default(16384),
  contextChars: z.number().int().min(10000).max(2000000),
  outputChars: z.number().int().min(1000).max(100000),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
});
