/**
 * Local 发布的明确验证命令契约及单次顺序执行计划，供 Engine 与候选 Runtime 共用。
 * 1. validationCommands 复制有界字符串列表；不接收 cwd、环境、权限或可执行文件覆盖。
 * 2. CandidateCommandPlan 作为固定 ModelProvider 适配既有 Runtime loop，每次只发出下一条 run_command。
 * 3. commit 核对已发出的工具 ID/名称及完整反馈，记录真实退出码；失败停止，丢失回执不重发。
 * 4. exitCode 仅在全部命令确认完成后为零；Runtime 的文本完成不能代替命令结果。
 * 不调用模型 API、不执行命令、不将工具输出当指令；输出由外层历史事件存储，计划只持有有界状态。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelProvider } from "../providers/model-provider.js";
import type { RuntimeIpcBrokerHandlers } from "../sandbox/runtime-ipc-broker-session.js";

export function validationCommands(input: unknown) {
  return z
    .array(z.string().trim().min(1).max(32_000))
    .min(1)
    .max(8)
    .parse(input);
}

export class CandidateCommandPlan implements ModelProvider {
  private readonly commands: string[];
  private issued = 0;
  private pending?: string;
  private readonly results: (number | null)[] = [];

  constructor(commands: readonly string[]) {
    this.commands = validationCommands(commands);
  }

  get exitCode(): number | null {
    const failure = this.results.find((value) => value !== 0);
    if (failure !== undefined) {
      return failure;
    }

    return this.results.length === this.commands.length && !this.pending
      ? 0
      : null;
  }

  async getCapabilities() {
    return {
      limits: { max_context_window_tokens: 300_000, max_output_tokens: 1_024 },
    };
  }

  async run() {
    if (this.pending) {
      throw new Error("候选命令缺少已提交回执，禁止重发。");
    }

    if (
      this.results.some((code) => code !== 0) ||
      this.issued === this.commands.length
    ) {
      return { text: "Candidate validation commands finished.", output: [] };
    }

    const callId = `validation-${randomUUID()}`;
    const command = this.commands[this.issued++]!;
    this.pending = callId;

    return {
      text: "",
      output: [
        {
          type: "function_call",
          call_id: callId,
          name: "run_command",
          arguments: JSON.stringify({
            execution: { id: callId, dependsOn: [] },
            arguments: { command },
          }),
        },
      ],
    };
  }

  commit(
    body: Parameters<
      NonNullable<RuntimeIpcBrokerHandlers["commitToolResult"]>
    >[1],
  ) {
    const { event, feedback } = body;
    if (
      !this.pending ||
      event.callId !== this.pending ||
      event.name !== "run_command" ||
      feedback.call_id !== this.pending ||
      feedback.output !== JSON.stringify(event.result)
    ) {
      throw new Error("候选工具回执与当前命令不匹配。");
    }

    const result = event.result as {
      exitCode?: unknown;
      error?: unknown;
    } | null;
    const code =
      result && result.error === undefined && Number.isInteger(result.exitCode)
        ? (result.exitCode as number)
        : null;
    this.results.push(code);
    this.pending = undefined;
  }
}
