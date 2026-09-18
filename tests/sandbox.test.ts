/**
 * 验证 Sandbox S0/S1 的环境开关、Broker 分流、WorkspaceView 与安全失败边界。
 * 测试直接使用 Config 和 SandboxBroker；临时配置目录避免读取用户设置，假的 runtime 只证明契约分流，
 * 不把它当成任何平台隔离实现。
 *
 * 1. 配置用例检查空值/false 保留 non-isolated，以及非法值和 true 的 unknown 初始状态。
 * 2. Broker 关闭时调用传入的既有宿主执行器，并记录可审计但不含命令内容的生命周期阶段。
 * 3. S1 WorkspaceView 以真实临时目录验证直接受保护项、链接逃逸和普通路径的策略边界。
 * 4. 启用而没有 runtime 时拒绝，不调用宿主执行器；测试 runtime 必须声明并接收工作区保护契约。
 *
 * 用例不启动真实 shell、不访问网络或用户项目。它证明 S0/S1 的安全失败和策略契约，不证明 Windows、Linux
 * 或 macOS 已提供 OS 级隔离。
 */

import { afterEach, expect, it, vi } from "vitest";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { SandboxBroker } from "../src/sandbox/broker.js";
import { sandboxConfiguration } from "../src/sandbox/config.js";
import { WorkspaceView } from "../src/sandbox/workspace-view.js";
import type { SandboxRuntime, SandboxStage } from "../src/sandbox/types.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => vi.unstubAllEnvs());

function command() {
  return {
    command: "shell",
    args: ["-c", "echo safe"],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    timeoutMs: 1000,
    outputLimit: 1000,
    onOutput: () => {},
  };
}

it("parses the startup-only sandbox switch strictly and exposes an honest initial status", async () => {
  expect(sandboxConfiguration({}).initialStatus).toMatchObject({
    enabled: false,
    mode: "non-isolated",
  });
  expect(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "false" })
      .initialStatus,
  ).toMatchObject({ enabled: false, mode: "non-isolated" });
  expect(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }).initialStatus,
  ).toMatchObject({ enabled: true, mode: "unknown" });
  expect(() =>
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "yes" }),
  ).toThrow("CODEATELIER_SANDBOX_ENABLED");

  vi.stubEnv("CODEATELIER_SANDBOX_ENABLED", "true");
  const config = new Config(await temp());
  vi.stubEnv("CODEATELIER_SANDBOX_ENABLED", "false");

  expect(config.publicValue().sandbox).toMatchObject({
    enabled: true,
    mode: "unknown",
  });
});

it("uses the existing host executor only while sandbox is explicitly disabled", async () => {
  const broker = new SandboxBroker(sandboxConfiguration({}));
  const executeHost = vi.fn(async () => ({
    output: "host output",
    exitCode: 0,
    truncated: false,
  }));
  const stages: SandboxStage[] = [];

  const outcome = await broker.executeCommand(command(), executeHost, (stage) =>
    stages.push(stage),
  );

  expect(outcome).toMatchObject({
    result: { output: "host output", exitCode: 0 },
    status: { mode: "non-isolated" },
  });
  expect(executeHost).toHaveBeenCalledOnce();
  expect(stages).toEqual([
    "policy_resolved",
    "executing",
    "collecting",
    "completed",
  ]);
});

it("rejects direct protected targets and links that escape the workspace", async () => {
  const root = await temp();
  const outside = await temp();
  const view = await WorkspaceView.open(root);

  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "src"));
  await symlink(
    outside,
    path.join(root, "outside-link"),
    process.platform === "win32" ? "junction" : "dir",
  );

  expect(view.descriptor()).toMatchObject({
    root,
    protectedPaths: [".env", ".git"],
    protection: "direct-path",
  });
  await expect(view.resolveDirectPath(".env.local")).rejects.toMatchObject({
    code: "SANDBOX_WORKSPACE_REJECTED",
  });
  await expect(view.resolveDirectPath(".git/config")).rejects.toMatchObject({
    code: "SANDBOX_WORKSPACE_REJECTED",
  });
  await expect(
    view.resolveDirectPath("outside-link/file.txt"),
  ).rejects.toMatchObject({
    code: "SANDBOX_WORKSPACE_REJECTED",
  });
  await expect(view.resolveDirectPath("src/new-file.ts")).resolves.toBe(
    path.join(root, "src", "new-file.ts"),
  );
});

it("fails closed without a verified runtime and never falls back to host execution", async () => {
  const broker = new SandboxBroker(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }),
  );
  const executeHost = vi.fn(async () => ({
    output: "must not run",
    exitCode: 0,
    truncated: false,
  }));
  const stages: SandboxStage[] = [];

  await expect(
    broker.executeCommand(command(), executeHost, (stage) =>
      stages.push(stage),
    ),
  ).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });

  expect(executeHost).not.toHaveBeenCalled();
  expect(broker.status.mode).toBe("unknown");
  expect(stages).toEqual(["policy_resolved", "provisioning", "failed"]);
});

it("dispatches only to a runtime that passed self-check", async () => {
  const runtime: SandboxRuntime = {
    selfCheck: vi.fn(async () => ({
      level: "test-isolation",
      workspaceProtection: "direct-path" as const,
    })),
    execute: vi.fn(async () => ({
      output: "sandbox output",
      exitCode: 0,
      truncated: false,
    })),
  };
  const broker = new SandboxBroker(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }),
    runtime,
  );
  const executeHost = vi.fn();

  const outcome = await broker.executeCommand(command(), executeHost, () => {});

  expect(outcome).toMatchObject({
    result: { output: "sandbox output", exitCode: 0 },
    status: { mode: "sandboxed", level: "test-isolation" },
  });
  expect(runtime.selfCheck).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    expect.objectContaining({
      root: await WorkspaceView.open(process.cwd()).then((view) => view.root),
      protectedPaths: [".env", ".git"],
      protection: "direct-path",
    }),
  );
  expect(runtime.execute).toHaveBeenCalledOnce();
  expect(executeHost).not.toHaveBeenCalled();
});
