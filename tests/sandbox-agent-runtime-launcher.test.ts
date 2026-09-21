/**
 * 验证 SandboxBroker 作为产品 AgentRuntimeLauncher 时的 provision、fallback 与 unknown 边界。
 * 测试使用临时普通目录和内存流，不启动 Windows 账户、native supervisor、ACL 或 WFP；原生身份验证另由平台验收覆盖。
 *
 * 1. 正常启动必须在 Runtime started 后提交共享 grant，close 时先关闭进程再原生撤销并清理私有目录。
 * 2. self-check 在 Runtime 创建前失败时允许显式 host-process fallback，不留下活动 lease。
 * 3. Supervisor 回传的 generation 摘要必须与 preflight 一致，否则按已启动 Runtime 的 unknown 处理。
 * 4. 已启动 Runtime 的 close 若无法证明 clean，或 Broker 未取得可信任务终态，必须 quarantine 并调用整代排空，绝不降级成 fallback。
 */

import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxBroker } from "../src/sandbox/broker.js";
import { AgentRuntimeFallbackError } from "../src/sandbox/agent-runtime-launcher.js";
import type { SandboxRuntime } from "../src/sandbox/types.js";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca-runtime-launcher-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const privateDirectory = path.join(root, "private");
  const gitConfig = path.join(root, "gitconfig");
  await Promise.all([
    mkdir(workspace),
    mkdir(privateDirectory),
    writeFile(gitConfig, "[user]\n\tname = sandbox\n"),
  ]);

  return { workspace, privateDirectory, gitConfig };
}

function identity() {
  return {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "instance-1",
    kind: "agent-runtime" as const,
  };
}

function configuration() {
  return {
    enabled: true,
    initialStatus: {
      enabled: true,
      requested: true,
      applied: false,
      mode: "host-process-fallback" as const,
      platform: process.platform,
      level: null,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SandboxBroker Agent Runtime launcher", () => {
  it("commits provision only after Runtime start and releases every grant on clean close", async () => {
    const files = await fixture();
    const cleanup = vi.fn(async () => {});
    const revokeAccess = vi.fn(async () => {});
    const nativeClose = vi.fn(async () => "clean" as const);
    const runtime: SandboxRuntime = {
      selfCheck: vi.fn(async () => ({
        level: "windows-sandbox-user-test",
        workspaceProtection: "direct-path" as const,
        accountGenerationDigest: "a".repeat(64),
      })),
      prepareAccess: vi.fn(async () => ({
        readOnlyRoots: [],
        readWriteRoots: [files.privateDirectory],
        gitConfigFiles: [files.gitConfig],
        privateDirectory: files.privateDirectory,
        gitGlobalConfigPath: files.gitConfig,
        cleanup,
      })),
      execute: vi.fn(async () => ({
        output: "",
        exitCode: 0,
        truncated: false,
      })),
      launchAgentRuntime: vi.fn(async (command) => {
        command.onAccessProvisioned?.();
        const transport = new PassThrough();

        return {
          input: transport,
          output: transport,
          pid: 42,
          processCreationTime100ns: "1234",
          accountGenerationDigest: "a".repeat(64),
          close: nativeClose,
        };
      }),
      revokeAccess,
    };
    const broker = new SandboxBroker(configuration(), runtime);

    const launched = await broker.launch({
      identity: identity(),
      nonce: "b".repeat(64),
      workspace: files.workspace,
      signal: new AbortController().signal,
    });

    expect(broker.accountGenerationSnapshot()?.activeInstanceCount).toBe(1);
    expect(broker.statusFor("task-1", "instance-1")).toMatchObject({
      mode: "sandboxed",
      applied: true,
      level: "windows-sandbox-user-test",
    });
    await expect(launched.close("completed")).resolves.toBe("clean");
    expect(nativeClose).toHaveBeenCalledWith("completed");
    expect(revokeAccess).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(broker.accountGenerationSnapshot()?.activeInstanceCount).toBe(0);
  });

  it("allows host fallback only when preflight fails before a Runtime starts", async () => {
    const files = await fixture();
    const runtime: SandboxRuntime = {
      selfCheck: vi.fn(async () => {
        throw new Error("not installed");
      }),
      execute: vi.fn(async () => ({
        output: "",
        exitCode: 0,
        truncated: false,
      })),
    };
    const broker = new SandboxBroker(configuration(), runtime);

    await expect(
      broker.launch({
        identity: identity(),
        nonce: "b".repeat(64),
        workspace: files.workspace,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeFallbackError);
    expect(broker.statusFor("task-1", "instance-1").mode).toBe(
      "host-process-fallback",
    );
    expect(broker.accountGenerationSnapshot()).toBeUndefined();
  });

  it("quarantines and drains the generation when a started Runtime is orphaned", async () => {
    const files = await fixture();
    const drainGeneration = vi.fn(async () => {});
    const runtime: SandboxRuntime = {
      selfCheck: vi.fn(async () => ({
        level: "windows-sandbox-user-test",
        workspaceProtection: "direct-path" as const,
        accountGenerationDigest: "c".repeat(64),
      })),
      prepareAccess: vi.fn(async () => ({
        readOnlyRoots: [],
        readWriteRoots: [files.privateDirectory],
        gitConfigFiles: [files.gitConfig],
        privateDirectory: files.privateDirectory,
        gitGlobalConfigPath: files.gitConfig,
        cleanup: vi.fn(async () => {}),
      })),
      execute: vi.fn(async () => ({
        output: "",
        exitCode: 0,
        truncated: false,
      })),
      launchAgentRuntime: vi.fn(async (command) => {
        command.onAccessProvisioned?.();
        const transport = new PassThrough();

        return {
          input: transport,
          output: transport,
          pid: 43,
          accountGenerationDigest: "c".repeat(64),
          close: async () => "orphaned" as const,
        };
      }),
      drainGeneration,
    };
    const broker = new SandboxBroker(configuration(), runtime);
    const launched = await broker.launch({
      identity: identity(),
      nonce: "d".repeat(64),
      workspace: files.workspace,
      signal: new AbortController().signal,
    });

    await expect(launched.close("failed")).resolves.toBe("orphaned");
    expect(drainGeneration).toHaveBeenCalledOnce();
    expect(broker.accountGenerationSnapshot()?.state).toBe("quarantined");
  });

  it("quarantines a generation when the Runtime result is unknown even after clean native shutdown", async () => {
    const files = await fixture();
    const nativeClose = vi.fn(async () => "clean" as const);
    const revokeAccess = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    const drainGeneration = vi.fn(async () => {});
    const runtime: SandboxRuntime = {
      selfCheck: vi.fn(async () => ({
        level: "windows-sandbox-user-test",
        workspaceProtection: "direct-path" as const,
        accountGenerationDigest: "d".repeat(64),
      })),
      prepareAccess: vi.fn(async () => ({
        readOnlyRoots: [],
        readWriteRoots: [files.privateDirectory],
        gitConfigFiles: [files.gitConfig],
        privateDirectory: files.privateDirectory,
        gitGlobalConfigPath: files.gitConfig,
        cleanup,
      })),
      execute: vi.fn(async () => ({
        output: "",
        exitCode: 0,
        truncated: false,
      })),
      launchAgentRuntime: vi.fn(async (command) => {
        command.onAccessProvisioned?.();
        const transport = new PassThrough();

        return {
          input: transport,
          output: transport,
          pid: 45,
          accountGenerationDigest: "d".repeat(64),
          close: nativeClose,
        };
      }),
      revokeAccess,
      drainGeneration,
    };
    const broker = new SandboxBroker(configuration(), runtime);
    const launched = await broker.launch({
      identity: identity(),
      nonce: "e".repeat(64),
      workspace: files.workspace,
      signal: new AbortController().signal,
    });

    await expect(launched.close("unknown")).resolves.toBe("orphaned");
    expect(nativeClose).toHaveBeenCalledWith("unknown");
    expect(drainGeneration).toHaveBeenCalledOnce();
    expect(revokeAccess).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(broker.statusFor("task-1", "instance-1")).toMatchObject({
      mode: "unknown",
      applied: false,
      failureCategory: "runtime_execution",
    });
    expect(broker.accountGenerationSnapshot()?.state).toBe("quarantined");
  });

  it("quarantines a started Runtime when Supervisor reports another generation", async () => {
    const files = await fixture();
    const drainGeneration = vi.fn(async () => {});
    const runtime: SandboxRuntime = {
      selfCheck: vi.fn(async () => ({
        level: "windows-sandbox-user-test",
        workspaceProtection: "direct-path" as const,
        accountGenerationDigest: "e".repeat(64),
      })),
      prepareAccess: vi.fn(async () => ({
        readOnlyRoots: [],
        readWriteRoots: [files.privateDirectory],
        gitConfigFiles: [files.gitConfig],
        privateDirectory: files.privateDirectory,
        gitGlobalConfigPath: files.gitConfig,
        cleanup: vi.fn(async () => {}),
      })),
      execute: vi.fn(async () => ({
        output: "",
        exitCode: 0,
        truncated: false,
      })),
      launchAgentRuntime: vi.fn(async (command) => {
        command.onAccessProvisioned?.();
        const transport = new PassThrough();

        return {
          input: transport,
          output: transport,
          pid: 44,
          accountGenerationDigest: "f".repeat(64),
          close: async () => "clean" as const,
        };
      }),
      drainGeneration,
    };
    const broker = new SandboxBroker(configuration(), runtime);

    await expect(
      broker.launch({
        identity: identity(),
        nonce: "a".repeat(64),
        workspace: files.workspace,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("禁止宿主重放");
    expect(drainGeneration).toHaveBeenCalledOnce();
    expect(broker.accountGenerationSnapshot()?.state).toBe("quarantined");
  });
});
