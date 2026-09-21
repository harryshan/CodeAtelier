/**
 * 验证 Agent Runtime 正式入口的 Supervisor 首帧契约，不把 stdio 测试夹具环境变量当作产品启动材料。
 *
 * 1. 覆盖合法 pipe 命名空间、分片首帧和同批到达的后续 IPC 字节。
 * 2. 覆盖远程/错误 pipe、超限长度、未知字段和非法 nonce 的安全拒绝。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { RuntimeBrokerGateway } from "../src/sandbox/runtime-capability-core.js";
import { RuntimeIpcBrokerSession } from "../src/sandbox/runtime-ipc-broker-session.js";
import {
  MAX_RUNTIME_STARTUP_FRAME_BYTES,
  RuntimeStartupProtocolError,
  encodeRuntimeStartupDescriptor,
  readRuntimeStartupDescriptor,
  validateRuntimeStartupPipeName,
} from "../src/sandbox/runtime-startup-protocol.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { temp } from "./fixtures/helpers.js";

const descriptor = {
  protocolVersion: 1 as const,
  identity: {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "instance-1",
    kind: "agent-runtime" as const,
  },
  nonce: "a".repeat(64),
};

describe("Runtime startup protocol", () => {
  it("reads a fragmented descriptor and preserves following IPC bytes", async () => {
    const stream = new PassThrough();
    const frame = encodeRuntimeStartupDescriptor(descriptor);
    const read = readRuntimeStartupDescriptor(
      stream,
      new AbortController().signal,
    );

    stream.write(frame.subarray(0, 3));
    stream.write(
      Buffer.concat([frame.subarray(3), Buffer.from("next-frame\n")]),
    );

    await expect(read).resolves.toEqual(descriptor);
    expect(stream.read()?.toString("utf8")).toBe("next-frame\n");
  });

  it("only accepts the fixed local Agent Runtime pipe namespace", () => {
    expect(
      validateRuntimeStartupPipeName(
        "\\\\.\\pipe\\CodeAtelier.AgentRuntime.123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toContain("CodeAtelier.AgentRuntime");
    expect(() =>
      validateRuntimeStartupPipeName(
        "\\\\remote\\pipe\\CodeAtelier.AgentRuntime.instance",
      ),
    ).toThrow(RuntimeStartupProtocolError);
    expect(() =>
      validateRuntimeStartupPipeName("C:\\temp\\runtime.pipe"),
    ).toThrow(RuntimeStartupProtocolError);
  });

  it("rejects oversized and schema-invalid startup frames", async () => {
    const oversized = new PassThrough();
    const oversizedRead = readRuntimeStartupDescriptor(
      oversized,
      new AbortController().signal,
    );
    const length = Buffer.alloc(4);
    length.writeUInt32LE(MAX_RUNTIME_STARTUP_FRAME_BYTES + 1);
    oversized.end(length);
    await expect(oversizedRead).rejects.toThrow("长度无效");

    const invalid = new PassThrough();
    const payload = Buffer.from(
      JSON.stringify({ ...descriptor, nonce: "bad", extra: true }),
    );
    const invalidLength = Buffer.alloc(4);
    invalidLength.writeUInt32LE(payload.byteLength);
    const invalidRead = readRuntimeStartupDescriptor(
      invalid,
      new AbortController().signal,
    );
    invalid.end(Buffer.concat([invalidLength, payload]));
    await expect(invalidRead).rejects.toThrow("schema 无效");
  });
});

it.skipIf(process.platform !== "win32")(
  "starts the fixed Agent Runtime entry through a real local named pipe",
  async () => {
    const pipeName = `\\\\.\\pipe\\CodeAtelier.AgentRuntime.${randomUUID()}`;
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipeName, resolve);
    });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("src/sandbox/agent-runtime-main.ts"),
        pipeName,
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
        env: process.env,
      },
    );
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      server.once("connection", resolve);
      server.once("error", reject);
    });
    server.close();
    socket.write(encodeRuntimeStartupDescriptor(descriptor));

    const traces = new TraceRecorder();
    traces.startTask(descriptor.identity.taskId, descriptor.identity.sessionId);
    const gateway = new RuntimeBrokerGateway(
      {
        authorize: (identity) => identity === descriptor.identity,
        approveCommand: async () => ({ approved: true }),
        modelProvider: () => ({
          model: "fixture-model",
          provider: {
            async getCapabilities() {
              return {
                limits: {
                  max_context_window_tokens: 64_000,
                  max_output_tokens: 1_024,
                },
              };
            },
            async run() {
              return { text: "named-pipe-complete", output: [] };
            },
          },
        }),
      },
      traces,
    );
    let context: unknown[] = [];
    let completed = false;
    const broker = new RuntimeIpcBrokerSession(
      { input: socket, output: socket },
      descriptor.identity,
      descriptor.nonce,
      gateway,
      {
        requestApproval: async () => ({ approved: true }),
        executeGitPush: async () => ({
          output: "",
          exitCode: 0,
          truncated: false,
        }),
        executeCapabilityCommand: async () => ({
          executionInstanceId: "capability-test",
          output: "",
          exitCode: 0,
          truncated: false,
        }),
        applyMemory: async () => ({ applied: true }),
        appendSessionEvent: async () => undefined,
        saveContext: async (_identity, input) => {
          context = structuredClone(input);
        },
        readContext: async () => structuredClone(context),
        readEvents: async () => [],
        latestContextSnapshot: async () => undefined,
        readContextSnapshot: async () => undefined,
        compactContext: async () => undefined,
        runtimeCompleted: async (_identity, result) => {
          completed = result.status === "completed";
        },
      },
    );
    const result = await broker.startTask(
      {
        workspace: await temp(),
        prompt: "完成命名管道启动回归",
        settings: {
          model: "fixture-model",
          maxSteps: 2,
          commandTimeoutMs: 10_000,
          maxOutputTokens: 1_024,
          contextChars: 64_000,
          outputChars: 10_000,
        },
      },
      AbortSignal.timeout(15_000),
    );

    broker.peer.end();
    const exit = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );

    expect(result).toEqual({ status: "completed" });
    expect(completed).toBe(true);
    expect(Buffer.concat(errors).toString("utf8")).toBe("");
    expect(exit).toBe(0);
  },
);
