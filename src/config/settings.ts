/**
 * 用 Zod 校验后端设置，Config 在启动和更新配置时都会使用这里的规则。
 * 校验后的设置通过共享的 Settings 类型传递给其他模块。
 *
 * 1. connectionSettingsSchema 校验只从环境读取的 API 地址、主模型和辅助模型标识。
 * 2. persistedSettingsSchema 描述 settings.json 可保存的偏好：思考等级、任务并发及其他执行限制和日志级别。
 * 3. settingsSchema 将两类字段合成为运行时 Settings，供 Engine 和浏览器的只读连接信息使用。
 *
 * 增加字段时要同步 Settings、配置读写和设置界面。通过校验只表示配置格式合法，
 * 服务是否支持对应能力还需要向服务查询。连接字段不得加入 persistedSettingsSchema，
 * 否则会重新引入 .env 与 settings.json 的来源冲突。
 */

import { z } from "zod";

export const connectionSettingsSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
  model: z.string().trim().min(1).max(200),
  auxiliaryModel: z.string().trim().max(200).default(""),
});

export const persistedSettingsSchema = z.object({
  reasoningEffort: z.enum(["low", "medium", "high"]).default("high"),
  auxiliaryReasoningEffort: z.enum(["low", "medium", "high"]).default("low"),
  maxSteps: z.number().int().min(1).max(100),
  // 全局硬上限避免并行模型和子进程耗尽本机或服务端资源。
  maxConcurrentTasks: z.number().int().min(1).max(4).default(2),
  commandTimeoutMs: z.number().int().min(1000).max(600000),
  requestTimeoutMs: z.number().int().min(1000).max(600000),
  idleTimeoutMs: z.number().int().min(1000).max(300000),
  maxOutputTokens: z.number().int().min(1).max(2000000).default(16384),
  contextChars: z.number().int().min(10000).max(2000000),
  outputChars: z.number().int().min(1000).max(100000),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
});

export const settingsSchema = connectionSettingsSchema.extend(
  persistedSettingsSchema.shape,
);
