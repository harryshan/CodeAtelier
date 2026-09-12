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
