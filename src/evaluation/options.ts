/**
 * 校验 runEvaluation 的参数，命令行入口和直接调用都使用同一套规则。
 * EvaluationOptions 从 schema 推导，避免类型与校验要求不一致。
 *
 * 1. 目录和提示字段指定工作区、任务内容和报告位置。
 * 2. 预算字段分别限制总 token、模型调用次数、任务步数和总时长；unlimited 显式关闭这些评测专属上限。
 * 3. allowWorkspaceCommands 默认关闭；开启后仍须通过 runner.ts 的环境和目录检查。
 *
 * 这里只检查参数格式，真实路径是否重叠、是否满足 Docker 运行条件由运行器检查。
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
  unlimited: z.boolean().default(false),
  allowWorkspaceCommands: z.boolean().default(false),
});

export type EvaluationOptions = z.infer<typeof evaluationOptionsSchema>;
