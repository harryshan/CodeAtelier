/**
 * 验证移除 Push/Capability Runner 后，旧请求不能获得执行或租约权限。
 * 使用 Broker、账户租约和 Supervisor schema 的公开入口，不启动原生进程、网络或真实服务。
 *
 * 1. Broker 在 Sandbox 关闭及启用但缺失后端时均拒绝旧 kind，不将其降级成宿主命令。
 * 2. 账户注册表拒绝旧 kind，拒绝后实例和共享 grant 账本保持为空。
 * 3. Supervisor 控制请求拒绝旧 runtimeKind，仍接受 Agent Runtime 的合法请求。
 * 历史 ExecutionInstanceRecord 的旧 kind 仅用于回读，不作为新请求的授权依据。
 */

import { expect, it, vi } from "vitest";
import { SandboxBroker } from "../src/sandbox/broker.js";
import { sandboxConfiguration } from "../src/sandbox/config.js";
import { AccountGenerationRegistry } from "../src/sandbox/account-generation.js";
import {
  supervisorRequestSchema,
  SUPERVISOR_PROTOCOL_VERSION,
} from "../src/sandbox/supervisor-protocol.js";
import { buildAccessManifest } from "../src/sandbox/access-manifest.js";
import type { SandboxCommand } from "../src/sandbox/types.js";
import { temp } from "./fixtures/helpers.js";

for (const kind of ["push-runner", "capability-runner"] as const) {
  it.each([false, true])(
    `rejects retired ${kind} without host fallback (enabled=%s)`,
    async (enabled) => {
      const broker = new SandboxBroker(
        sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: String(enabled) }),
      );
      const executeHost = vi.fn(async () => ({
        output: "must not execute",
        exitCode: 0,
        truncated: false,
      }));
      const command = {
        kind,
        sessionId: "session",
        taskId: "task",
        executionInstanceId: "retired",
        command: "unused",
        args: [],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 0,
        outputLimit: 1000,
        onOutput: () => {},
        onProcessStarted: () => {},
      } as unknown as SandboxCommand;

      await expect(
        broker.executeCommand(command, executeHost, () => {}),
      ).rejects.toThrow("不再支持独立 Runner");
      expect(executeHost).not.toHaveBeenCalled();
    },
  );

  it(`rejects retired ${kind} in leases and supervisor requests`, async () => {
    const accessManifest = await buildAccessManifest({
      workspaceRoot: await temp(),
    });
    const registry = new AccountGenerationRegistry("a".repeat(64));
    const input = {
      executionInstanceId: "retired",
      taskId: "task",
      kind,
      accessManifest,
    } as unknown as Parameters<typeof registry.acquire>[0];

    expect(() => registry.acquire(input)).toThrow("不再支持独立 Runner");
    expect(registry.snapshot()).toMatchObject({
      activeInstanceCount: 0,
      grantCount: 0,
    });

    const request = {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      requestId: "request",
      operation: "launch_runtime",
      executionInstanceId: "instance",
      runtimeKind: kind,
      sessionId: "session",
      taskId: "task",
      leaseEpoch: 1,
      accessManifest,
    };
    expect(supervisorRequestSchema.safeParse(request).success).toBe(false);
    expect(
      supervisorRequestSchema.safeParse({
        ...request,
        runtimeKind: "agent-runtime",
      }).success,
    ).toBe(true);
  });
}
