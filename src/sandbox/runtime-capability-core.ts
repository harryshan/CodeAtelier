/**
 * 为 Windows Runtime→Broker 私有 IPC 提供传输无关的 typed capability 核心。
 * supervisor/Named Pipe 层负责取得真实连接身份并构造 RuntimeExecutionIdentity；本模块不打开 pipe、
 * 不信任 Runtime 自报 PID/SID，也不直接启动进程，而是把已认证请求接到现有审批与模型提供者。
 *
 * 1. requestCommandApproval 校验固定请求形状，调用宿主审批适配器，并签发绑定 execution instance、请求摘要和期限的一次性 grant。
 * 2. consumeCommandGrant 在 Runtime 真正执行前消费 grant；错误实例、过期、篡改和重放都会拒绝，未来 supervisor 可直接复用。
 * 3. requestModel 从宿主选择 ModelProvider，Runtime 永远拿不到 API 地址或密钥；模型调用沿用 tracedModelProvider 并标记 Sandbox execution。
 * 4. authorize 回调用真实 pipe/process/Job/token 联合证明连接；日志和 trace 只记录数量、决策、kind 和关联 ID，不记录命令、路径、prompt 或输出。
 *
 * 当前产品尚未接入 Named Pipe transport。本模块只是 capability core，不是 Agent Runtime、Runtime IPC
 * 或进程启动器，也不代表 W1--W3 身份证明或
 * Windows supervisor 已完成；任何 transport 在调用本模块前仍必须完成权威身份核验。
 */

import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  ModelProvider,
  ModelResult,
} from "../providers/model-provider.js";
import { tracedModelProvider } from "../tracing/model-provider.js";
import type { TraceRecorder } from "../tracing/recorder.js";

const MAX_COMMAND_CHARS = 32_000;
const MAX_CWD_CHARS = 4_096;
const DEFAULT_GRANT_TTL_MS = 30_000;

export interface RuntimeExecutionIdentity {
  sessionId: string;
  taskId: string;
  executionInstanceId: string;
  kind: "agent-runtime" | "push-runner";
}

export interface RuntimeCommandApprovalRequest {
  requestId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface RuntimeCommandApprovalResponse {
  requestId: string;
  decision: "approved" | "denied";
  grantId?: string;
  expiresAt?: number;
  requestDigest: string;
  reason?: string;
}

export interface RuntimeModelRequest {
  requestId: string;
  purpose: "task" | "compaction";
  input: any[];
  instructions: string;
  tools: any[];
  maxOutputTokens?: number;
}

export interface RuntimeBrokerHandlers {
  authorize(identity: RuntimeExecutionIdentity): boolean;
  approveCommand(
    identity: RuntimeExecutionIdentity,
    request: RuntimeCommandApprovalRequest,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string }>;
  modelProvider(
    identity: RuntimeExecutionIdentity,
    purpose: RuntimeModelRequest["purpose"],
  ): { provider: ModelProvider; model: string };
}

interface CommandGrant {
  executionInstanceId: string;
  requestDigest: string;
  expiresAt: number;
}

export class RuntimeBrokerAuthorizationError extends Error {
  readonly code = "SANDBOX_BROKER_UNAUTHORIZED";

  constructor() {
    super("Runtime 未通过 Broker 身份验证。");
    this.name = "RuntimeBrokerAuthorizationError";
  }
}

function commandDigest(request: RuntimeCommandApprovalRequest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: request.command,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
      }),
    )
    .digest("hex");
}

function validateCommandRequest(request: RuntimeCommandApprovalRequest) {
  if (
    !request.requestId ||
    !request.command ||
    request.command.length > MAX_COMMAND_CHARS ||
    !request.cwd ||
    request.cwd.length > MAX_CWD_CHARS ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs <= 0
  ) {
    throw new Error("Runtime command approval 请求无效。");
  }
}

/** 传输无关的 Broker 能力实现；调用方负责在实例结束时丢弃对象，从而撤销全部未消费 grant。 */
export class RuntimeBrokerGateway {
  private commandGrants = new Map<string, CommandGrant>();

  constructor(
    private handlers: RuntimeBrokerHandlers,
    private traces: TraceRecorder,
    private log?: Logger,
    private now: () => number = Date.now,
  ) {}

  private assertAuthorized(identity: RuntimeExecutionIdentity) {
    if (!this.handlers.authorize(identity)) {
      this.log?.warn({
        event: "broker.runtime_request_rejected",
        module: "sandbox",
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        kind: identity.kind,
      });
      throw new RuntimeBrokerAuthorizationError();
    }
  }

  async requestCommandApproval(
    identity: RuntimeExecutionIdentity,
    request: RuntimeCommandApprovalRequest,
    signal: AbortSignal,
  ): Promise<RuntimeCommandApprovalResponse> {
    this.assertAuthorized(identity);
    validateCommandRequest(request);
    signal.throwIfAborted();
    const requestDigest = commandDigest(request);
    const span = this.traces.startSpan(identity.taskId, {
      name: "broker.command_approval",
      category: "sandbox",
      track: "Sandbox broker",
      attributes: {
        executionInstanceId: identity.executionInstanceId,
        runtimeKind: identity.kind,
        commandChars: request.command.length,
      },
    });

    try {
      const decision = await this.handlers.approveCommand(
        identity,
        request,
        signal,
      );
      signal.throwIfAborted();
      if (!decision.approved) {
        this.traces.endSpan(span, "ok", { decision: "denied" });
        this.log?.info({
          event: "broker.command_approval_decided",
          module: "sandbox",
          sessionId: identity.sessionId,
          taskId: identity.taskId,
          kind: identity.kind,
          decision: "denied",
        });

        return {
          requestId: request.requestId,
          decision: "denied",
          requestDigest,
          reason: decision.reason,
        };
      }

      const grantId = randomUUID();
      const expiresAt = this.now() + DEFAULT_GRANT_TTL_MS;
      this.commandGrants.set(grantId, {
        executionInstanceId: identity.executionInstanceId,
        requestDigest,
        expiresAt,
      });
      this.traces.endSpan(span, "ok", { decision: "approved" });
      this.log?.info({
        event: "broker.command_approval_decided",
        module: "sandbox",
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        kind: identity.kind,
        decision: "approved",
      });

      return {
        requestId: request.requestId,
        decision: "approved",
        grantId,
        expiresAt,
        requestDigest,
      };
    } catch (error) {
      this.traces.endSpan(span, signal.aborted ? "cancelled" : "error", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  consumeCommandGrant(
    identity: RuntimeExecutionIdentity,
    grantId: string,
    request: RuntimeCommandApprovalRequest,
  ) {
    this.assertAuthorized(identity);
    validateCommandRequest(request);
    const grant = this.commandGrants.get(grantId);
    this.commandGrants.delete(grantId);

    const accepted =
      !!grant &&
      grant.executionInstanceId === identity.executionInstanceId &&
      grant.expiresAt >= this.now() &&
      grant.requestDigest === commandDigest(request);
    this.log?.info({
      event: "broker.command_grant_consumed",
      module: "sandbox",
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      kind: identity.kind,
      accepted,
    });

    return accepted;
  }

  async requestModelCapabilities(
    identity: RuntimeExecutionIdentity,
    purpose: RuntimeModelRequest["purpose"],
    signal: AbortSignal,
  ) {
    this.assertAuthorized(identity);
    signal.throwIfAborted();
    const selected = this.handlers.modelProvider(identity, purpose);

    return selected.provider.getCapabilities?.(signal);
  }

  async requestModel(
    identity: RuntimeExecutionIdentity,
    request: RuntimeModelRequest,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<ModelResult> {
    this.assertAuthorized(identity);
    signal.throwIfAborted();
    const selected = this.handlers.modelProvider(identity, request.purpose);
    this.log?.info({
      event: "broker.model_request_started",
      module: "sandbox",
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      kind: identity.kind,
      purpose: request.purpose,
      inputItems: request.input.length,
      toolCount: request.tools.length,
    });
    const provider = tracedModelProvider(selected.provider, this.traces, {
      taskId: identity.taskId,
      purpose: request.purpose,
      model: selected.model,
      executionMode: "windows-sandbox-user",
      executionInstanceId: identity.executionInstanceId,
      runtimeKind: identity.kind,
      brokered: true,
    });

    try {
      const result = await provider.run(
        request.input,
        request.instructions,
        request.tools,
        signal,
        onDelta,
        { maxOutputTokens: request.maxOutputTokens },
      );
      this.log?.info({
        event: "broker.model_request_completed",
        module: "sandbox",
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        kind: identity.kind,
        purpose: request.purpose,
        outputItems: result.output.length,
      });

      return result;
    } catch (error) {
      const code =
        error && typeof error === "object" ? Reflect.get(error, "code") : null;
      this.log?.warn({
        event: "broker.model_request_failed",
        module: "sandbox",
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        kind: identity.kind,
        purpose: request.purpose,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode:
          typeof code === "string" || typeof code === "number"
            ? String(code).slice(0, 80)
            : undefined,
      });
      throw error;
    }
  }
}
