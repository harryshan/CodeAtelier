/**
 * 用 Zod 校验后端设置，Config 在启动和更新配置时都会使用这里的规则。
 * 校验后的设置通过共享的 Settings 类型传递给其他模块。
 *
 * 1. 连接设置包括 API 地址、主模型、辅助模型及各自的思考等级；旧配置缺少的字段有默认值。
 * 2. 执行设置限制任务步数、命令和模型超时，以及上下文和输出大小。
 * 3. 日志设置限定可选级别。
 *
 * 增加字段时要同步 Settings、配置读写和设置界面。通过校验只表示配置格式合法，
 * 服务是否支持对应能力还需要向服务查询。
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
