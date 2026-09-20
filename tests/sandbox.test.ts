/**
 * 验证 Sandbox S0/S1 的环境开关、Broker 分流、WorkspaceView、WSL inspect runtime 请求形状与安全失败边界。
 * 测试直接使用 Config 和 SandboxBroker；临时配置目录避免读取用户设置，假的 runtime 只证明契约分流，
 * WSL Runtime 以注入的进程执行器检查固定启动器参数，不把单元测试当成任何平台隔离实现。
 *
 * 1. 配置用例检查空值/false 保留 non-isolated，以及非法值和 true 的 unknown 初始状态。
 * 2. Broker 关闭时调用传入的既有宿主执行器，并记录可审计但不含命令内容的生命周期阶段。
 * 3. S1 WorkspaceView 以真实临时目录验证整个工作区（含 .git/.env）可访问，同时拒绝链接逃逸。
 * 4. 启用而没有 runtime 或自检失败时明确回退宿主，同一任务保持 fallback；runtime 执行已开始后的失败不重放。
 * 5. 测试 runtime 必须声明并接收工作区保护契约；Windows inspect 路径只交给 WSL 固定 POSIX shell 形状。
 *
 * 用例不启动真实 shell、不访问网络或用户项目。它证明策略、请求形状与安全失败；实际 WSL2 bubblewrap
 * 隔离只能由平台夹具和验证记录证明，不能推广为 Windows 原生或其他平台的 OS 级隔离。
 */

import { afterEach, expect, it, vi } from "vitest";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { SandboxBroker } from "../src/sandbox/broker.js";
import { sandboxConfiguration } from "../src/sandbox/config.js";
import { createSandboxRuntime } from "../src/sandbox/runtime-factory.js";
import { NativeWindowsSandboxRuntime } from "../src/sandbox/native-windows-runtime.js";
import { WorkspaceView } from "../src/sandbox/workspace-view.js";
import { WslInspectRuntime } from "../src/sandbox/wsl-inspect-runtime.js";
import { commandShell } from "../src/tools/command-shell.js";
import type { SandboxRuntime, SandboxStage } from "../src/sandbox/types.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => vi.unstubAllEnvs());

function command() {
  return {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "execution-1",
    command: "shell",
    args: ["-c", "echo safe"],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    timeoutMs: 1000,
    outputLimit: 1000,
    onOutput: () => {},
    onProcessStarted: () => {},
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

it("keeps the Windows sandbox implementation disabled on macOS and Linux", () => {
  for (const platform of ["darwin", "linux"] as const) {
    expect(
      sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }, platform),
    ).toEqual({
      enabled: false,
      initialStatus: {
        enabled: false,
        requested: false,
        applied: false,
        mode: "non-isolated",
        platform,
        level: null,
        reason: "Windows 专用账户 Sandbox 在 macOS/Linux 上已禁用。",
      },
    });
  }
});

it("selects the native dedicated-user runtime for enabled Windows", () => {
  expect(commandShell({}, () => false, "win32", true)).toEqual({
    command: "/bin/sh",
    args: ["-c"],
  });
  expect(commandShell({}, () => false, "win32", false)).toBeUndefined();
  expect(
    createSandboxRuntime(
      sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }),
      "win32",
    ),
  ).toBeInstanceOf(NativeWindowsSandboxRuntime);
  expect(
    createSandboxRuntime(
      sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }),
      "linux",
    ),
  ).toBeUndefined();
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

it("allows all workspace paths while rejecting links that escape the workspace", async () => {
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
    protectedPaths: [],
    protection: "direct-path",
  });
  await expect(view.resolveDirectPath(".env.local")).resolves.toBe(
    path.join(root, ".env.local"),
  );
  await expect(view.resolveDirectPath(".git/config")).resolves.toBe(
    path.join(root, ".git", "config"),
  );
  await expect(
    view.resolveDirectPath("outside-link/file.txt"),
  ).rejects.toMatchObject({
    code: "SANDBOX_WORKSPACE_REJECTED",
  });
  await expect(view.resolveDirectPath("src/new-file.ts")).resolves.toBe(
    path.join(root, "src", "new-file.ts"),
  );
});

it("falls back to host execution when no runtime is available", async () => {
  const broker = new SandboxBroker(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }),
  );
  const executeHost = vi.fn(async () => ({
    output: "host fallback",
    exitCode: 0,
    truncated: false,
  }));
  const stages: SandboxStage[] = [];

  const outcome = await broker.executeCommand(command(), executeHost, (stage) =>
    stages.push(stage),
  );

  expect(outcome).toMatchObject({
    result: { output: "host fallback", exitCode: 0 },
    status: {
      mode: "host-process-fallback",
      requested: true,
      applied: false,
      failureCategory: "runtime_missing",
    },
  });
  expect(executeHost).toHaveBeenCalledOnce();
  expect(stages).toEqual([
    "policy_resolved",
    "provisioning",
    "fallback_selected",
    "executing",
    "collecting",
    "completed",
  ]);
});

it("keeps one task on host fallback after self-check fails", async () => {
  const runtime: SandboxRuntime = {
    selfCheck: vi.fn(async () => {
      throw new Error("probe failed");
    }),
    execute: vi.fn(),
  };
  const broker = new SandboxBroker(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }),
    runtime,
  );
  const executeHost = vi.fn(async () => ({
    output: "host",
    exitCode: 0,
    truncated: false,
  }));
  const firstStages: SandboxStage[] = [];

  await broker.executeCommand(command(), executeHost, (stage) =>
    firstStages.push(stage),
  );
  const secondStages: SandboxStage[] = [];
  await broker.executeCommand(command(), executeHost, (stage) =>
    secondStages.push(stage),
  );

  expect(runtime.selfCheck).toHaveBeenCalledOnce();
  expect(runtime.execute).not.toHaveBeenCalled();
  expect(executeHost).toHaveBeenCalledTimes(2);
  expect(firstStages).toContain("fallback_selected");
  expect(secondStages).toEqual([
    "policy_resolved",
    "executing",
    "collecting",
    "completed",
  ]);

  broker.releaseTask("task-1");
  await broker.executeCommand(command(), executeHost, () => {});
  expect(runtime.selfCheck).toHaveBeenCalledTimes(2);
});

it("does not replay a command on the host after runtime execution starts", async () => {
  const runtime: SandboxRuntime = {
    selfCheck: vi.fn(async () => ({
      level: "test-isolation",
      workspaceProtection: "direct-path" as const,
    })),
    execute: vi.fn(async () => {
      throw new Error("result unknown");
    }),
  };
  const broker = new SandboxBroker(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }),
    runtime,
  );
  const executeHost = vi.fn();

  await expect(
    broker.executeCommand(command(), executeHost, () => {}),
  ).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
  expect(executeHost).not.toHaveBeenCalled();
  expect(broker.status).toMatchObject({
    mode: "unknown",
    applied: false,
    failureCategory: "runtime_execution",
  });
});

it("passes only fixed WSL launcher arguments to the inspect runtime", async () => {
  const runProcess = vi.fn(async () => ({
    output: "",
    exitCode: 0,
    truncated: false,
  }));
  const runtime = new WslInspectRuntime(runProcess);
  const workspace = (await WorkspaceView.open(process.cwd())).descriptor();

  await expect(
    runtime.selfCheck(new AbortController().signal, workspace),
  ).resolves.toMatchObject({
    level: "wsl2-bubblewrap-inspect",
    workspaceProtection: "direct-path",
  });
  await runtime.execute({ ...command(), command: "/bin/sh" }, workspace);

  expect(runProcess).toHaveBeenCalledTimes(2);
  expect(runProcess).toHaveBeenNthCalledWith(
    1,
    "wsl.exe",
    expect.arrayContaining([
      "--exec",
      "/bin/sh",
      "-c",
      "codeatelier-wsl-inspect",
      "self-check",
      workspace.root,
    ]),
    process.cwd(),
    expect.any(AbortSignal),
    10_000,
    1_000,
    expect.any(Function),
    {},
    undefined,
  );
  expect(runProcess).toHaveBeenLastCalledWith(
    "wsl.exe",
    expect.arrayContaining(["execute", workspace.root, "echo safe"]),
    process.cwd(),
    expect.any(AbortSignal),
    1_000,
    1_000,
    expect.any(Function),
    {},
    expect.any(Function),
  );
  expect(() =>
    runtime.execute(
      { ...command(), command: "cmd.exe", args: ["/c", "echo unsafe"] },
      workspace,
    ),
  ).toThrow("固定的 POSIX shell");
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
      protectedPaths: [],
      protection: "direct-path",
    }),
  );
  expect(runtime.execute).toHaveBeenCalledOnce();
  expect(executeHost).not.toHaveBeenCalled();
});
