/**
 * 为 Engine 与 Sandbox Broker 的 Responses 主/子模型调用绑定稳定缓存分组。
 * 调用方提供可信会话身份，子任务还提供任务与子任务 ID；不接收提示词、路径或凭据。
 *
 * 1. PromptCacheSubagent 描述子任务的命名空间，避免同名子任务跨主任务混用。
 * 2. withPromptCacheKey 仅包装 Responses（未声明协议的旧模拟提供者视为 Responses），
 *    对版本化身份元组求 SHA-256，产生有界的不透明 key；主任务不包含 taskId，允许续聊复用。
 * 3. run 在 tracing/Replay 包装器之前注入 key，保留其他选项、能力查询、流回调和取消/失败语义。
 *
 * 包装器不修改共享 provider 或输入，不持久化状态、不重试，也不保证服务端缓存命中。
 */

import { createHash } from "node:crypto";
import type { ModelProvider } from "./model-provider.js";

interface PromptCacheSubagent {
  taskId: string;
  subagentId: string;
}

export function withPromptCacheKey(
  provider: ModelProvider,
  sessionId: string,
  subagent?: PromptCacheSubagent,
): ModelProvider {
  if ((provider.protocol ?? "responses") !== "responses") {
    return provider;
  }

  const identity = subagent
    ? ["v1", "subagent", sessionId, subagent.taskId, subagent.subagentId]
    : ["v1", "main", sessionId];
  const hash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  const promptCacheKey = `ca1_${hash.slice(0, 48)}`;

  return {
    protocol: provider.protocol,
    getCapabilities: provider.getCapabilities?.bind(provider),
    run: (input, instructions, tools, signal, onDelta, options) =>
      provider.run(input, instructions, tools, signal, onDelta, {
        ...options,
        promptCacheKey,
      }),
  };
}
