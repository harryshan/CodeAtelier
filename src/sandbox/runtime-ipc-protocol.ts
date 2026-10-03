/**
 * 定义常驻 Agent Runtime 与 Broker Host 之间的固定应用层消息，而不承担连接身份认证。
 * Sandbox Supervisor/Windows transport 必须先把连接绑定到已验证的 PID、Job、token、generation、nonce 和 lease，
 * 然后才能把已认证字节流交给 RuntimeIpcPeer；测试用 stdio 只验证 framing 和跨进程路由，不构成 W3 证据。
 *
 * 1. runtimeRequestSchema 限定模型、审批、session adapter、任务绑定子状态/问题/租约、受限 Git action、MCP 两阶段请求与一次性 Broker 命令授权；Git push 旧入口只含调用 ID，不能扩展 Runtime 权限。
 * 2. runtimeResponseSchema 关联原 requestId；错误只返回受限 code/message 与模型重试元数据，避免泄露宿主异常对象。
 * 3. runtimeEventSchema 承载模型 delta、取消、Runtime 生命周期以及固定 context/tool/read_file/subagent trace span；微秒时间戳由 Runtime 单调时钟提供，Broker 核验后归档，名称与属性不是任意日志通道。
 * 4. hello schema 绑定协议版本、任务和 instance；其中 Runtime 自报字段只用于一致性核对，不能替代 transport 身份。
 */

import { z } from "zod";
import { mcpActionSchema } from "../mcp/contracts.js";
import { capabilityCommandRequestSchema } from "./capability-request.js";
import { contextSnapshotSchema } from "../context/types.js";
import { subtaskSchema } from "../agent/subagent-contracts.js";
import { gitRequestSchema } from "../tools/registry.js";

// v5 增加 MCP 两阶段 Broker adapter；旧安装包须 Repair，不能静默缺失 MCP 能力。
export const RUNTIME_IPC_PROTOCOL_VERSION = 5;
export const MAX_RUNTIME_IPC_FRAME_BYTES = 8 * 1024 * 1024;

const identifier = z.string().min(1).max(120);
const boundedText = z.string().max(2_000_000);
const runtimeTraceAttributesSchema = z
  .object({
    step: z.number().int().positive().max(1_000).optional(),
    attempt: z.number().int().positive().max(100).optional(),
    force: z.boolean().optional(),
    inputItems: z.number().int().nonnegative().max(2_000_000).optional(),
    toolCount: z.number().int().nonnegative().max(10_000).optional(),
    amount: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    errorName: z.string().min(1).max(120).optional(),
    subagentId: identifier.optional(),
    callId: identifier.optional(),
    slot: z.number().int().min(0).max(3).optional(),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024)
      .optional(),
    computeMs: z
      .number()
      .nonnegative()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
  })
  .strict();
const runtimeTraceNameSchema = z.enum([
  "context.prepare",
  "context.prepare.measure_request_view",
  "context.request",
  "context.request.measure_input",
  "tool.result_persist",
  "tool.execute",
  "read_file.pool.close",
  "read_file.stat",
  "read_file.bytes",
  "read_file.worker.queue",
  "read_file.worker.startup",
  "read_file.worker.response",
  "subagent.worker",
  "subagent.model",
  "subagent.tool.read",
  "subagent.message",
  "subagent.cancel",
  "subagent.question",
]);
const runtimeSessionEventTypeSchema = z.enum([
  "assistant",
  "command_output",
  "context.compaction_completed",
  "context.compaction_failed",
  "context.compaction_started",
  "context_budget",
  "delta",
  "diff",
  "edit_progress",
  "git_output",
  "model_request",
  "model_usage",
  "notice",
  "sandboxed_tool_process",
  "tool_batch_planned",
  "tool_result",
  "tool_start",
  "tool_state",
]);
const requestBase = {
  type: z.literal("request"),
  requestId: identifier,
};

/** 保留旧独立 Push Runner 的 PushSpec 校验形状；当前 IPC 不再接受 Runtime 自报 spec。 */
export const runtimeGitPushSpecSchema = z
  .object({
    remote: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    remoteUrl: z.string().url().max(32_767),
    host: z.string().min(1).max(253),
    refspec: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^HEAD:refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine(
        (value) =>
          !value.includes("..") &&
          !value.includes("//") &&
          !value.endsWith("/"),
      ),
    objectId: z.string().regex(/^[a-f0-9]{40,64}$/i),
  })
  .strict();

export const runtimeGitPushResultSchema = z
  .object({
    output: z.string().max(2_000_000),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
  })
  .strict();

const runtimeGitPathsSchema = z.array(z.string().min(1).max(1024)).max(100);

/** Broker Git 必须保留工具原有的 action-specific 结果形状和有界文本。 */
export const runtimeGitResultSchema = z.union([
  runtimeGitPushResultSchema,
  runtimeGitPushResultSchema.extend({
    staged: z.boolean(),
    paths: runtimeGitPathsSchema,
  }),
  z
    .object({ paths: runtimeGitPathsSchema, add: runtimeGitPushResultSchema })
    .strict(),
  z
    .object({
      paths: runtimeGitPathsSchema,
      stage: runtimeGitPushResultSchema,
      commit: runtimeGitPushResultSchema.nullable(),
    })
    .strict(),
]);

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
    maxContextTokens: z.number().int().min(4_096).max(2_000_000).optional(),
    contextChars: z.number().int().min(10_000).max(2_000_000),
    outputChars: z.number().int().min(1_000).max(100_000),
    subagentsEnabled: z.boolean().optional(),
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

export const runtimeSubagentStoreSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("plan"),
      subtasks: z.array(subtaskSchema).min(1).max(4),
    })
    .strict(),
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("update"),
      subagentId: identifier,
      status: z.enum([
        "planned",
        "queued",
        "running",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ]),
      context: z.array(z.unknown()).max(2_000),
      report: z.string().max(32_000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("request_start"),
      subagentId: identifier,
      requestId: identifier,
      kind: z.enum(["model", "read"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("request_finish"),
      subagentId: identifier,
      requestId: identifier,
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      action: z.literal("question"),
      subagentId: identifier,
      requestId: identifier,
      question: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("collect"),
      ids: z.array(identifier).min(1).max(4),
    })
    .strict(),
]);

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
          purpose: z.enum(["task", "compaction", "subagent"]),
          subagentId: identifier.optional(),
          subagentRequestId: identifier.optional(),
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
      operation: z.literal("prepare_mcp"),
      body: z
        .object({ toolCallId: identifier, request: mcpActionSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("execute_mcp"),
      body: z
        .object({ toolCallId: identifier, authorizationId: identifier })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("git_execute"),
      body: z
        .object({
          toolCallId: identifier,
          request: gitRequestSchema.shape.request,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("git_push"),
      body: z.object({ toolCallId: identifier }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("prepare_run_with_permissions"),
      body: z
        .object({
          toolCallId: identifier,
          request: capabilityCommandRequestSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("run_with_permissions"),
      body: z
        .object({
          toolCallId: identifier,
          authorizationId: identifier,
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
      operation: z.literal("subagent_store"),
      body: runtimeSubagentStoreSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("subagent_lease_acquire"),
      body: z.object({ subagentId: identifier }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("subagent_lease_release"),
      body: z.object({ leaseId: identifier }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_commit_subagent_collect"),
      body: z
        .object({
          ids: z.array(identifier).min(1).max(4),
          input: z.array(z.unknown()).max(100_000),
          event: z
            .object({
              name: z.literal("subagent"),
              callId: identifier,
              batchId: identifier,
              nodeId: identifier,
              result: z.unknown(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("session_append_event"),
      body: z
        .object({ eventType: runtimeSessionEventTypeSchema, data: z.unknown() })
        .strict(),
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
      operation: z.literal("session_append_context"),
      body: z.object({ items: z.array(z.unknown()).max(100_000) }).strict(),
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
        .object({
          snapshot: contextSnapshotSchema,
          input: z.array(z.unknown()).max(100_000),
        })
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
      event: z.literal("request_cancel"),
      requestId: identifier,
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
  z
    .object({
      type: z.literal("event"),
      event: z.literal("trace_span_start"),
      spanId: identifier,
      parentSpanId: identifier.optional(),
      timestampUs: z.number().int().safe().positive(),
      name: runtimeTraceNameSchema,
      attributes: runtimeTraceAttributesSchema,
    })
    .strict()
    .refine(
      (event) =>
        (event.name === "read_file.pool.close" ||
          (!event.name.startsWith("read_file.") &&
            event.name !== "tool.execute") ||
          !!event.attributes.callId) &&
        (event.name !== "tool.execute" || event.attributes.slot !== undefined),
      { message: "工具 trace 阶段必须关联调用标识和执行槽。" },
    ),
  z
    .object({
      type: z.literal("event"),
      event: z.literal("trace_span_end"),
      spanId: identifier,
      timestampUs: z.number().int().safe().positive(),
      status: z.enum(["cancelled", "error", "ok"]),
      attributes: runtimeTraceAttributesSchema,
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
export type RuntimeSubagentStoreRequest = z.infer<
  typeof runtimeSubagentStoreSchema
>;
