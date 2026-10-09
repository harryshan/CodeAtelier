/**
 * 在 Agent Runtime 内实现 ModelProvider，把能力查询和流式模型请求转发给 Broker Host。
 * Runtime 只持有已认证 RuntimeIpcPeer，不持有 endpoint、Bearer key 或宿主 provider 实例。
 *
 * 1. getCapabilities 请求 Broker adapter 并用现有 schema 校验，缺失能力保持 undefined。
 * 2. run 在发送请求前订阅关联 requestId 的 model_delta，完成或失败后立即移除监听。
 * 3. 子模型请求附带 Broker 已登记的 subagent ID/请求 ID，完整响应再次校验 ModelResult/usage；畸形 Broker 数据使当前任务失败，不能降级为直接联网。
 */

import { z } from "zod";
import type {
  ModelProvider,
  ModelResult,
} from "../providers/model-provider.js";
import {
  capabilitiesSchema,
  usageSchema,
  type ModelCapabilities,
} from "../providers/model-metadata.js";
import { RuntimeIpcError, RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import { ModelError } from "../providers/model-error.js";

const modelResultSchema = z.object({
  output: z.array(z.unknown()),
  text: z.string(),
  usage: usageSchema.optional(),
});

export class RuntimeModelProvider implements ModelProvider {
  constructor(
    private peer: RuntimeIpcPeer,
    private purpose: "task" | "compaction" | "subagent" | "tool_review",
    private subagent?: { id: string; requestId: string },
    private toolCallId?: string,
  ) {}

  async getCapabilities(
    signal: AbortSignal,
  ): Promise<ModelCapabilities | undefined> {
    const value = await this.peer.request(
      "model_capabilities",
      { purpose: this.purpose },
      signal,
    );
    if (value === undefined || value === null) {
      return undefined;
    }

    const parsed = capabilitiesSchema.safeParse(value);
    if (!parsed.success) {
      throw new RuntimeIpcError("Broker 返回了无效模型能力。");
    }

    return parsed.data;
  }

  async run(
    input: any[],
    instructions: string,
    tools: any[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    options?: { maxOutputTokens?: number },
  ): Promise<ModelResult> {
    const pending = this.peer.startRequest(
      "model_run",
      {
        purpose: this.purpose,
        toolCallId: this.toolCallId,
        subagentId: this.subagent?.id,
        subagentRequestId: this.subagent?.requestId,
        input,
        instructions,
        tools,
        maxOutputTokens: options?.maxOutputTokens,
      },
      signal,
    );
    const remove = this.peer.onEvent((event) => {
      if (
        event.event === "model_delta" &&
        event.requestId === pending.requestId
      ) {
        onDelta(event.text);
      }
    });
    try {
      const parsed = modelResultSchema.safeParse(await pending.result);
      if (!parsed.success) {
        throw new RuntimeIpcError("Broker 返回了无效模型结果。");
      }

      return parsed.data;
    } catch (error) {
      if (error instanceof RuntimeIpcError) {
        throw new ModelError(
          error.message,
          error.retryable,
          error.code,
          error.status,
          error.retryAfterMs,
          error.providerRequestId,
        );
      }

      throw error;
    } finally {
      remove();
    }
  }
}
