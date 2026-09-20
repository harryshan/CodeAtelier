/**
 * 验证 Windows supervisor 控制契约只允许固定操作和有界 AccessManifest。
 *
 * 1. launch_runtime 不能夹带任意 executable、command、SID 或 raw handle 字段。
 * 2. 客户端生成 requestId 并校验响应关联，正常启动只暴露恢复所需的 PID/创建时间与摘要。
 * 3. 错误 requestId、多余响应字段和 supervisor error 都安全拒绝。
 *
 * 测试使用内存 channel，不声称真实管道、进程或 Windows 身份已实现。
 */

import { expect, it, vi } from "vitest";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorProtocolClient,
  supervisorRequestSchema,
  type AccessManifest,
  type SupervisorControlChannel,
} from "../src/sandbox/supervisor-protocol.js";

const hash = "a".repeat(64);
const manifest: AccessManifest = {
  manifestDigest: hash,
  workspaceRootId: "workspace",
  readRoots: [],
  writeRoots: [
    {
      rootId: "workspace",
      path: "G:\\project",
      objectIdentityDigest: hash,
    },
  ],
  gitConfigFiles: [],
};

it("rejects arbitrary executable, command, SID and handle fields", () => {
  const base = {
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    requestId: "request-1",
    operation: "launch_runtime",
    executionInstanceId: "instance-1",
    runtimeKind: "agent-runtime",
    sessionId: "session-1",
    taskId: "task-1",
    leaseEpoch: 1,
    accessManifest: manifest,
  };

  for (const forbidden of [
    { executable: "cmd.exe" },
    { command: "whoami" },
    { accountSid: "S-1-5-18" },
    { processHandle: 1234 },
  ]) {
    expect(
      supervisorRequestSchema.safeParse({ ...base, ...forbidden }).success,
    ).toBe(false);
  }
});

it("returns only validated runtime identity and recovery digests", async () => {
  const request = vi.fn(async (outgoing: any) => ({
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    requestId: outgoing.requestId,
    result: "runtime_started",
    executionInstanceId: outgoing.executionInstanceId,
    runtimePid: 8123,
    processCreationTime100ns: "133700000000000000",
    leaseEpoch: outgoing.leaseEpoch,
    accountGenerationDigest: hash,
    jobDigest: hash,
    capabilityDigest: hash,
  }));
  const client = new SupervisorProtocolClient({ request });

  const response = await client.launchRuntime(
    {
      executionInstanceId: "instance-1",
      runtimeKind: "agent-runtime",
      sessionId: "session-1",
      taskId: "task-1",
      leaseEpoch: 2,
      accessManifest: manifest,
    },
    new AbortController().signal,
  );

  expect(response).toMatchObject({
    result: "runtime_started",
    runtimePid: 8123,
    processCreationTime100ns: "133700000000000000",
    leaseEpoch: 2,
  });
  expect(request).toHaveBeenCalledWith(
    expect.not.objectContaining({ executable: expect.anything() }),
    expect.any(AbortSignal),
  );
});

it("rejects mismatched, extended and explicit error responses", async () => {
  const responses = [
    {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      requestId: "different-request",
      result: "shutdown_complete",
    },
    {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      requestId: "placeholder",
      result: "shutdown_complete",
      rawHandle: 99,
    },
    {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      requestId: "placeholder",
      result: "error",
      category: "cleanup",
      retryable: false,
    },
  ];

  for (const template of responses) {
    const channel: SupervisorControlChannel = {
      async request(outgoing) {
        return {
          ...template,
          requestId:
            template.requestId === "placeholder"
              ? outgoing.requestId
              : template.requestId,
        };
      },
    };

    await expect(
      new SupervisorProtocolClient(channel).shutdown(
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_SUPERVISOR_PROTOCOL" });
  }
});
