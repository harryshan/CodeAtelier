/**
 * 定义 Sandbox Supervisor 向 Agent Runtime 交付一次性启动材料的首帧协议。
 * Agent Runtime 产品入口只从 Supervisor 创建的任务专属 Named Pipe 读取本帧；identity/nonce 不进入环境变量、命令行或工作区文件。
 *
 * 1. validateRuntimeStartupPipeName 只接受本机 CodeAtelier Agent Runtime pipe 名，拒绝远程 UNC、普通路径和其它命名空间。
 * 2. encodeRuntimeStartupDescriptor 供 native/测试契约生成长度前缀 UTF-8 JSON；正式 native 实现必须逐字段等价编码。
 * 3. readRuntimeStartupDescriptor 有界读取恰好一帧、严格校验 schema，并把已经随同读取的 IPC 字节退回流中。
 * 4. 首帧只完成启动材料交付；Supervisor 仍必须在发送前联合验证连接 PID、创建时间、Job、token/capability、generation 和 lease。
 */

import type { Readable } from "node:stream";
import { z } from "zod";
import type { RuntimeExecutionIdentity } from "./runtime-capability-core.js";

export const RUNTIME_STARTUP_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_STARTUP_FRAME_BYTES = 64 * 1024;
const PIPE_PREFIX = "\\\\.\\pipe\\CodeAtelier.AgentRuntime.";

const identifier = z.string().min(1).max(120);
const runtimeExecutionIdentitySchema = z
  .object({
    sessionId: identifier,
    taskId: identifier,
    executionInstanceId: identifier,
    kind: z.literal("agent-runtime"),
  })
  .strict();

export const runtimeStartupDescriptorSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_STARTUP_PROTOCOL_VERSION),
    identity: runtimeExecutionIdentitySchema,
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export interface RuntimeStartupDescriptor {
  protocolVersion: typeof RUNTIME_STARTUP_PROTOCOL_VERSION;
  identity: RuntimeExecutionIdentity & { kind: "agent-runtime" };
  nonce: string;
}

export class RuntimeStartupProtocolError extends Error {
  readonly code = "SANDBOX_RUNTIME_STARTUP_PROTOCOL";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeStartupProtocolError";
  }
}

export function validateRuntimeStartupPipeName(pipeName: string) {
  if (
    !pipeName.startsWith(PIPE_PREFIX) ||
    pipeName.length > 240 ||
    !/^[A-Za-z0-9.-]+$/.test(pipeName.slice(PIPE_PREFIX.length))
  ) {
    throw new RuntimeStartupProtocolError("Agent Runtime 启动 pipe 名称无效。");
  }

  return pipeName;
}

export function encodeRuntimeStartupDescriptor(
  descriptor: RuntimeStartupDescriptor,
) {
  const parsed = runtimeStartupDescriptorSchema.parse(descriptor);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8");
  if (payload.byteLength > MAX_RUNTIME_STARTUP_FRAME_BYTES) {
    throw new RuntimeStartupProtocolError("Agent Runtime 启动帧超过限制。");
  }

  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(payload.byteLength);

  return Buffer.concat([length, payload]);
}

export function readRuntimeStartupDescriptor(
  input: Readable,
  signal: AbortSignal,
): Promise<RuntimeStartupDescriptor> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let expected: number | undefined;
    let settled = false;

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () =>
      fail(
        signal.reason instanceof Error
          ? signal.reason
          : new RuntimeStartupProtocolError("Agent Runtime 启动已取消。"),
      );
    const onEnd = () =>
      fail(new RuntimeStartupProtocolError("Agent Runtime 启动帧不完整。"));
    const onError = () =>
      fail(
        new RuntimeStartupProtocolError("Agent Runtime 启动 pipe 读取失败。"),
      );
    const onData = (chunk: Buffer | string) => {
      buffered = Buffer.concat([
        buffered,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      if (expected === undefined && buffered.byteLength >= 4) {
        expected = buffered.readUInt32LE(0);
        if (expected < 2 || expected > MAX_RUNTIME_STARTUP_FRAME_BYTES) {
          fail(
            new RuntimeStartupProtocolError("Agent Runtime 启动帧长度无效。"),
          );

          return;
        }
      }

      if (expected === undefined || buffered.byteLength < expected + 4) {
        return;
      }

      const payload = buffered.subarray(4, expected + 4);
      const remainder = buffered.subarray(expected + 4);
      let raw: unknown;
      try {
        raw = JSON.parse(payload.toString("utf8"));
      } catch {
        fail(
          new RuntimeStartupProtocolError(
            "Agent Runtime 启动帧不是合法 JSON。",
          ),
        );

        return;
      }

      const parsed = runtimeStartupDescriptorSchema.safeParse(raw);
      if (!parsed.success) {
        fail(
          new RuntimeStartupProtocolError("Agent Runtime 启动帧 schema 无效。"),
        );

        return;
      }

      settled = true;
      cleanup();
      if (remainder.byteLength > 0) {
        input.unshift(remainder);
      }

      resolve(parsed.data);
    };

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
