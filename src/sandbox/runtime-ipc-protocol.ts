/**
 * 定义常驻 Agent Runtime 与 Broker Host 之间的固定应用层消息，而不承担连接身份认证。
 * Sandbox Supervisor/Windows transport 必须先把连接绑定到已验证的 PID、Job、token、generation、nonce 和 lease，
 * 然后才能把已认证字节流交给 RuntimeIpcPeer；测试用 stdio 只验证 framing 和跨进程路由，不构成 W3 证据。
 *
 * 1. runtimeRequestSchema 限定 Runtime 可请求的模型、审批和 session adapter，不提供任意宿主函数或路径入口。
 * 2. runtimeResponseSchema 关联原 requestId；错误只返回受限 code/message 与模型重试元数据，避免泄露宿主异常对象。
 * 3. runtimeEventSchema 承载模型 delta、Broker 取消和 Runtime 生命周期通知；大对象仍受 transport 帧上限约束。
 * 4. hello schema 绑定协议版本、任务和 instance；其中 Runtime 自报字段只用于一致性核对，不能替代 transport 身份。
 */

import { z } from "zod";

export const RUNTIME_IPC_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_IPC_FRAME_BYTES = 8 * 1024 * 1024;

const identifier = z.string().min(1).max(120);
const boundedText = z.string().max(2_000_000);
const requestBase = {
  type: z.literal("request"),
  requestId: identifier,
};

export const runtimeTaskSettingsSchema = z
  .object({
    model: identifier,
    maxSteps: z.number().int().min(1).max(1_000),
    commandTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000),
    maxOutputTokens: z.number().int().positive().max(2_000_000).optional(),
    contextChars: z.number().int().min(10_000).max(2_000_000),
    outputChars: z.number().int().min(1_000).max(100_000),
  })
  .strict();

export const runtimeHelloSchema = z
  .object({
    type: z.literal("runtime_hello"),
    protocolVersion: z.literal(RUNTIME_IPC_PROTOCOL_VERSION),
    sessionId: identifier,
    taskId: identifier,
    executionInstanceId: identifier,
    nonce: z.string().min(32).max(256),
  })
  .strict();

export const brokerHelloSchema = z
  .object({
    type: z.literal("broker_hello"),
    protocolVersion: z.literal(RUNTIME_IPC_PROTOCOL_VERSION),
    executionInstanceId: identifier,
  })
  .strict();

export const runtimeRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...requestBase,
      operation: z.literal("start_task"),
      body: z
        .object({
          workspace: z.string().min(1).max(32_767),
          prompt: boundedText,
          settings: runtimeTaskSettingsSchema,
          memoryText: z.string().max(100_000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("model_capabilities"),
      body: z.object({ purpose: z.enum(["task", "compaction"]) }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("model_run"),
      body: z
        .object({
          purpose: z.enum(["task", "compaction"]),
          input: z.array(z.unknown()),
          instructions: boundedText,
          tools: z.array(z.unknown()),
          maxOutputTokens: z
            .number()
            .int()
            .positive()
            .max(2_000_000)
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("approval_request"),
      body: z
        .object({
          tool: identifier,
          description: z.string().min(1).max(32_000),
          grantKey: z.string().min(1).max(64_000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("memory_apply"),
      body: z.object({ request: z.unknown() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_append_event"),
      body: z.object({ eventType: identifier, data: z.unknown() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_save_context"),
      body: z.object({ input: z.array(z.unknown()) }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_read_context"),
      body: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_read_events"),
      body: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_latest_snapshot"),
      body: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_read_snapshot"),
      body: z.object({ snapshotId: identifier }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_compact"),
      body: z
        .object({ snapshot: z.unknown(), input: z.array(z.unknown()) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("runtime_complete"),
      body: z
        .object({
          status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
          failure: z.string().max(2_000).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const runtimeResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("response"),
      requestId: identifier,
      ok: z.literal(true),
      value: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("response"),
      requestId: identifier,
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1).max(120),
          message: z.string().min(1).max(1_000),
          retryable: z.boolean().optional(),
          status: z.number().int().min(100).max(599).optional(),
          retryAfterMs: z.number().int().min(0).max(30_000).optional(),
          providerRequestId: z.string().min(1).max(128).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const runtimeEventSchema = z.discriminatedUnion("event", [
  z
    .object({
      type: z.literal("event"),
      event: z.literal("model_delta"),
      requestId: identifier,
      text: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      event: z.literal("cancel"),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      event: z.literal("runtime_state"),
      state: z.enum(["ready", "running", "stopping"]),
    })
    .strict(),
]);

export const runtimeIpcMessageSchema = z.union([
  runtimeHelloSchema,
  brokerHelloSchema,
  runtimeRequestSchema,
  runtimeResponseSchema,
  runtimeEventSchema,
]);

export type RuntimeIpcRequest = z.infer<typeof runtimeRequestSchema>;
export type RuntimeIpcResponse = z.infer<typeof runtimeResponseSchema>;
export type RuntimeIpcEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeIpcMessage = z.infer<typeof runtimeIpcMessageSchema>;
export type RuntimeIpcOperation = RuntimeIpcRequest["operation"];
export type RuntimeTaskSettings = z.infer<typeof runtimeTaskSettingsSchema>;
