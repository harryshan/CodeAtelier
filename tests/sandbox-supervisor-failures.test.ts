/**
 * 用内存管道模拟 Supervisor，验证宿主持久化回调和管道故障不会逃出事件监听器。
 * 通过 NativeWindowsSandboxRuntime.execute 和 launchAgentRuntime 的真实编码与收尾路径执行，不启动账户或原生程序。
 * 1. 为每个场景创建独立子进程替身，注入 PID、stdout 或 stdin 故障。
 * 2. 故障必须关闭控制输入并等待 close；有清理证明时返回原错误，没有证明时保持 cleanup_unknown，Supervisor 诊断只能记录白名单阶段与数字码。
 * 3. finally 关闭全部内存流并恢复替身，避免测试留下计时器或调用记录。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { NativeWindowsSandboxRuntime } from "../src/sandbox/native-windows-runtime.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it.each(["runtime-launcher", "runtime"] as const)(
  "cleans up Agent Runtime startup when its %s callback fails",
  async (phase) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);
    const root = path.resolve(".");
    const failure = new Error("startup persistence failed");
    const warnings: Record<string, unknown>[] = [];
    const log = {
      warn: (details: Record<string, unknown>) => warnings.push(details),
    } as unknown as Logger;
    const runtime = new NativeWindowsSandboxRuntime(
      { ProgramData: root },
      undefined,
      log,
    );
    const pending = runtime.launchAgentRuntime(
      {
        sessionId: "session",
        taskId: "task",
        executionInstanceId: "instance",
        command: process.execPath,
        args: [],
        cwd: root,
        signal: new AbortController().signal,
        timeoutMs: 1000,
        outputLimit: 1000,
        onOutput: () => {},
        onProcessStarted: (_pid, kind) => {
          if (kind === phase) {
            throw failure;
          }
        },
      },
      { root, protectedPaths: [], protection: "direct-path" },
      {
        privateDirectory: root,
        gitGlobalConfigPath: path.join(root, "gitconfig"),
        installObjectIdentityDigests: [],
        manifest: {
          manifestDigest: "a".repeat(64),
          workspaceRootId: "root",
          readRoots: [],
          writeRoots: [],
          gitConfigFiles: [],
        },
      },
      {
        sessionId: "session",
        taskId: "task",
        executionInstanceId: "instance",
        kind: "agent-runtime",
      },
      "b".repeat(64),
    );
    const outcome = pending.catch((error: unknown) => error);
    try {
      if (phase === "runtime") {
        expect(() =>
          child.stderr.emit(
            "data",
            "CODEATELIER_RUNTIME_STARTED pid=456 created100ns=789\n",
          ),
        ).not.toThrow();
      }

      expect(child.stdin.writableEnded).toBe(true);
      child.stderr.emit(
        "data",
        "CODEATELIER_STATION_ACL_FAILED stage=account_ace\n" +
          "CODEATELIER_SUPERVISOR_BOOTSTRAP_FAILED exit_code=3221225794\n" +
          "CODEATELIER_RUNTIME_PROXY_FAILED stage=identity\n" +
          "CODEATELIER_RUNTIME_CLIENT_REJECT stage=process win32=5\n" +
          "private path and output must not enter logs\n",
      );
      child.stderr.emit(
        "data",
        "CODEATELIER_SUPERVISOR_COMPLETE\nCODEATELIER_SUPERVISOR_ROLLBACK_COMPLETE\n",
      );
      child.emit("close", 0);
      expect(await outcome).toBe(failure);
      expect(warnings).toMatchObject([
        {
          event: "sandbox.agent_runtime_supervisor_prestart_failed",
          diagnostic: {
            stage: "account_ace",
            bootstrapExitCode: 3221225794,
            proxyStage: "identity",
            clientStage: "process",
            clientWin32: 5,
          },
        },
      ]);
      expect(JSON.stringify(warnings)).not.toContain("private path");
    } finally {
      child.emit("close", 0);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await outcome;
    }
  },
);

it.each([
  ["pid", true],
  ["output", true],
  ["stdin", true],
  ["pid", false],
  ["output", false],
  ["stdin", false],
] as const)(
  "contains supervisor %s failures with cleanup proof=%s",
  async (phase, cleanupProof) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);
    const failure = new Error("persistence or pipe failure");
    const root = path.resolve(".");
    const runtime = new NativeWindowsSandboxRuntime({});
    const pending = runtime.execute(
      {
        sessionId: "session",
        taskId: "task",
        executionInstanceId: "instance",
        command: process.execPath,
        args: [],
        cwd: root,
        signal: new AbortController().signal,
        timeoutMs: 1000,
        outputLimit: 1000,
        onProcessStarted: () => {
          if (phase === "pid") {
            throw failure;
          }
        },
        onOutput: () => {
          if (phase === "output") {
            throw failure;
          }
        },
      },
      { root, protectedPaths: [], protection: "direct-path" },
      {
        privateDirectory: root,
        installObjectIdentityDigests: [],
        manifest: {
          manifestDigest: "a".repeat(64),
          workspaceRootId: "root",
          readRoots: [],
          writeRoots: [],
          gitConfigFiles: [],
        },
      },
    );
    let settled = false;
    const outcome = pending
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      if (phase === "output") {
        expect(() => child.stdout.emit("data", "output")).not.toThrow();
      } else if (phase === "stdin") {
        expect(() => child.stdin.emit("error", failure)).not.toThrow();
      }

      expect(child.stdin.writableEnded).toBe(true);
      await Promise.resolve();
      expect(settled).toBe(false);
      if (cleanupProof) {
        child.stderr.emit("data", "CODEATELIER_SUPERVISOR_ROLLBACK_COMPLETE\n");
      }

      child.emit("close", 0);
      if (cleanupProof) {
        expect(await outcome).toBe(failure);
      } else {
        expect(await outcome).toMatchObject({
          name: "NativeWindowsSandboxCleanupError",
        });
      }
    } finally {
      child.emit("close", 0);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await outcome;
    }
  },
);
