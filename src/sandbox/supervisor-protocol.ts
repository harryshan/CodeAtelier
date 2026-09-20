/**
 * 定义 Broker 与 Windows C++ supervisor 之间的固定、严格控制协议。
 * Broker 先规范化 AccessManifest，supervisor 只创建固定类型的 Agent Runtime 或 Push Runner；
 * Runtime 自身不得连接这条控制通道。
 *
 * 1. requestSchema 只允许 self_check、launch_runtime、terminate_runtime 和 shutdown，所有对象 strict 校验。
 * 2. launch_runtime 只接受固定 runtimeKind 和有界 AccessManifest，不接受可执行文件、argv、命令、SID、ACL 或代理端口。
 * 3. responseSchema 只返回 PID、创建时间、generation/Job/capability 摘要和清理结果，不返回原始 handle。
 * 4. SupervisorProtocolClient 生成 requestId、校验请求与响应相关性，并把 supervisor 错误转为固定异常。
 *
 * 真实 transport 必须使用 Broker 独占的私有 handle/pipe，核对 supervisor 二进制和父进程，
 * 限制帧大小和超时。本文件只实现传输无关的契约，不把 mock 通道当作安全边界。
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SUPERVISOR_PROTOCOL_VERSION = 1;

const identifier = z.string().min(1).max(120);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalPath = z.string().min(1).max(32_767);

const manifestRootSchema = z
  .object({
    rootId: identifier,
    path: canonicalPath,
    objectIdentityDigest: digest,
    deviceId: z.string().regex(/^\d+$/),
    fileId: z.string().regex(/^\d+$/),
  })
  .strict();

export const accessManifestSchema = z
  .object({
    manifestDigest: digest,
    workspaceRootId: identifier,
    readRoots: z.array(manifestRootSchema).max(32),
    writeRoots: z.array(manifestRootSchema).min(1).max(32),
    gitConfigFiles: z.array(manifestRootSchema).max(32),
  })
  .strict();

const requestBase = {
  protocolVersion: z.literal(SUPERVISOR_PROTOCOL_VERSION),
  requestId: identifier,
};

export const supervisorRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...requestBase,
      operation: z.literal("self_check"),
      brokerPid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("launch_runtime"),
      executionInstanceId: identifier,
      runtimeKind: z.enum(["agent-runtime", "push-runner"]),
      sessionId: identifier,
      taskId: identifier,
      leaseEpoch: z.number().int().positive(),
      accessManifest: accessManifestSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("terminate_runtime"),
      executionInstanceId: identifier,
      reason: z.enum(["cancel", "shutdown", "orphaned"]),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      operation: z.literal("shutdown"),
    })
    .strict(),
]);

const responseBase = {
  protocolVersion: z.literal(SUPERVISOR_PROTOCOL_VERSION),
  requestId: identifier,
};

export const supervisorResponseSchema = z.discriminatedUnion("result", [
  z
    .object({
      ...responseBase,
      result: z.literal("self_check_ok"),
      supervisorPid: z.number().int().positive(),
      supervisorBinaryDigest: digest,
      accountGenerationDigest: digest,
    })
    .strict(),
  z
    .object({
      ...responseBase,
      result: z.literal("runtime_started"),
      executionInstanceId: identifier,
      runtimePid: z.number().int().positive(),
      processCreationTime100ns: z.string().regex(/^\d+$/),
      leaseEpoch: z.number().int().positive(),
      accountGenerationDigest: digest,
      jobDigest: digest,
      capabilityDigest: digest,
    })
    .strict(),
  z
    .object({
      ...responseBase,
      result: z.literal("runtime_terminated"),
      executionInstanceId: identifier,
      cleanup: z.enum(["clean", "orphaned"]),
    })
    .strict(),
  z
    .object({
      ...responseBase,
      result: z.literal("shutdown_complete"),
    })
    .strict(),
  z
    .object({
      ...responseBase,
      result: z.literal("error"),
      category: z.enum([
        "protocol",
        "self_check",
        "account",
        "manifest",
        "launch",
        "termination",
        "cleanup",
      ]),
      retryable: z.boolean(),
    })
    .strict(),
]);

export type AccessManifest = z.infer<typeof accessManifestSchema>;
export type SupervisorRequest = z.infer<typeof supervisorRequestSchema>;
export type SupervisorResponse = z.infer<typeof supervisorResponseSchema>;

export interface SupervisorControlChannel {
  request(request: SupervisorRequest, signal: AbortSignal): Promise<unknown>;
}

export class SupervisorProtocolError extends Error {
  readonly code = "SANDBOX_SUPERVISOR_PROTOCOL";

  constructor(message: string) {
    super(message);
    this.name = "SupervisorProtocolError";
  }
}

export class SupervisorProtocolClient {
  constructor(private channel: SupervisorControlChannel) {}

  private async exchange(
    request: SupervisorRequest,
    signal: AbortSignal,
  ): Promise<SupervisorResponse> {
    signal.throwIfAborted();
    const outgoing = supervisorRequestSchema.parse(request);
    const incoming = supervisorResponseSchema.safeParse(
      await this.channel.request(outgoing, signal),
    );

    if (!incoming.success) {
      throw new SupervisorProtocolError("Supervisor 返回了无效响应。");
    }

    if (incoming.data.requestId !== outgoing.requestId) {
      throw new SupervisorProtocolError("Supervisor 响应与请求不匹配。");
    }

    if (incoming.data.result === "error") {
      throw new SupervisorProtocolError(
        `Supervisor 拒绝了 ${outgoing.operation} 请求（${incoming.data.category}）。`,
      );
    }

    return incoming.data;
  }

  selfCheck(brokerPid: number, signal: AbortSignal) {
    return this.exchange(
      {
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        requestId: randomUUID(),
        operation: "self_check",
        brokerPid,
      },
      signal,
    );
  }

  launchRuntime(
    input: {
      executionInstanceId: string;
      runtimeKind: "agent-runtime" | "push-runner";
      sessionId: string;
      taskId: string;
      leaseEpoch: number;
      accessManifest: AccessManifest;
    },
    signal: AbortSignal,
  ) {
    return this.exchange(
      {
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        requestId: randomUUID(),
        operation: "launch_runtime",
        ...input,
      },
      signal,
    );
  }

  terminateRuntime(
    executionInstanceId: string,
    reason: "cancel" | "shutdown" | "orphaned",
    signal: AbortSignal,
  ) {
    return this.exchange(
      {
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        requestId: randomUUID(),
        operation: "terminate_runtime",
        executionInstanceId,
        reason,
      },
      signal,
    );
  }

  shutdown(signal: AbortSignal) {
    return this.exchange(
      {
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        requestId: randomUUID(),
        operation: "shutdown",
      },
      signal,
    );
  }
}
