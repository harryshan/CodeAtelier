/**
 * 文件作用：定义手动评测的工作目录、输出位置和预算参数契约。
 *
 * 模块协作与输入输出：
 * 供 runEvaluation 校验来自 CLI 或直接调用的参数；类型 EvaluationOptions 从同一 schema 推导。
 *
 * 代码结构与执行顺序：
 * 1. 目录和提示字段明确任务输入与记录输出位置。
 * 2. maxTotalTokens、maxModelCalls、maxSteps 和 timeoutMs 分别约束用量、调用、任务步数和时长。
 * 3. allowWorkspaceCommands 默认关闭，实际审批还要经过运行器的环境和目录检查。
 *
 * 关键约束：
 * schema 只验证参数形状；真实路径分离与 Docker 运行条件由 runner.ts 校验。
 */

import { z } from "zod";

export const evaluationOptionsSchema = z.object({
  workspace: z.string().min(1),
  outputDir: z.string().min(1),
  prompt: z.string().min(1).max(200000),
  maxTotalTokens: z.number().int().positive().max(100000000).default(500000),
  maxModelCalls: z.number().int().min(1).max(1000).default(60),
  maxSteps: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(100).max(3600000).default(600000),
  allowWorkspaceCommands: z.boolean().default(false),
});

export type EvaluationOptions = z.infer<typeof evaluationOptionsSchema>;
