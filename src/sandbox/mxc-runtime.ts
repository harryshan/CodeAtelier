/**
 * MXC 1.0.0 的 Linux/Bubblewrap 与 macOS/Seatbelt 产品启动器，由平台工厂交给 SandboxBroker。
 * 1. recoverStartup/selfCheck 初始化标记目录、核对残留与平台限制；launch 预检再核对后端和可信 bundle。未知实例阻止新启动，不猜 PID、不 fallback。
 * 2. launchTask 为每任务规范化根、复制只读代码、持久化启动标记，再创建私有 stdio；首帧只走管道，不继承宿主秘密。
 * 3. SDK spawn 不可取消：取消/启动超时后仍接管迟到 handle 并终止，绝不重放；进程 wait 与清理各自有界。
 * 4. close 幂等终止 MXC handle、等待退出并释放实例；unknown/清理失败隔离本启动器、排空活动实例，保留故障标记供人工核对。
 * 5. 日志和 tracing 记录 preflight/launch/cleanup、关联 ID、耗时与终态，不记录路径、nonce、正文或 stderr。
 * 逐命令旧 Runner 不开放；Git/MCP/获批宿主命令继续通过 Broker。Mac 进程组/后代语义尚待实机验证。
 */

import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import type { ContainerRequest, MxcProcess } from "@microsoft/mxc-sdk/v1";
import type { TraceRecorder } from "../tracing/recorder.js";
import type {
  AgentRuntimeLauncher,
  LaunchedAgentRuntime,
} from "./agent-runtime-launcher.js";
import {
  SandboxUnavailableError,
  type SandboxRuntime,
  type SandboxWorkspace,
} from "./types.js";
import { encodeRuntimeStartupDescriptor } from "./runtime-startup-protocol.js";
import {
  assertDisjointRoots,
  createMxcRequest,
  mxcExecutionMode,
  type MxcPlatform,
} from "./mxc-policy.js";
import {
  defaultMxcBundleDirectory,
  prepareMxcFiles,
  readMxcBundle,
} from "./mxc-runtime-files.js";

type MxcSdk = Pick<
  typeof import("@microsoft/mxc-sdk/v1"),
  "spawn" | "getPlatformSupport"
>;
type LaunchInput = Parameters<AgentRuntimeLauncher["launch"]>[0];
type MxcHandle = Pick<
  MxcProcess,
  | "id"
  | "standardInput"
  | "standardOutput"
  | "standardError"
  | "wait"
  | "kill"
  | "dispose"
>;

export interface MxcRuntimeOptions {
  platform: MxcPlatform;
  dataDirectory: string;
  bundleDirectory?: string;
  nodeExecutable?: string;
  readRoots?: string[];
  writeRoots?: string[];
  log?: Logger;
  traces?: TraceRecorder;
  /** 仅供离线测试注入，不从配置/模型接受执行函数。 */
  loadSdk?: () => Promise<
    Pick<MxcSdk, "getPlatformSupport"> & {
      spawn(request: ContainerRequest): Promise<MxcHandle>;
    }
  >;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("MXC 生命周期等待超时。")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class MxcSandboxRuntime implements SandboxRuntime {
  private recovery?: Promise<void>;
  private blocked = false;
  private active = new Map<string, LaunchedAgentRuntime>();
  private readonly journalDirectory: string;

  constructor(private options: MxcRuntimeOptions) {
    this.journalDirectory = path.join(options.dataDirectory, "mxc", "active");
  }

  async recoverStartup(signal: AbortSignal) {
    this.recovery ??= (async () => {
      signal.throwIfAborted();
      await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
      if ((await readdir(this.journalDirectory)).length) {
        this.blocked = true;
        throw new SandboxUnavailableError(
          "MXC 存在未核对的上次启动标记；需人工确认进程已停止后恢复。",
        );
      }
    })();
    await this.recovery;
  }

  async selfCheck(signal: AbortSignal, _workspace: SandboxWorkspace) {
    void _workspace;
    await this.recoverStartup(signal);
    if (this.blocked) {
      throw new SandboxUnavailableError(
        "MXC 启动器已隔离，禁止新任务或宿主重放。",
      );
    }

    if (
      this.options.platform === "darwin" &&
      process.platform === "darwin" &&
      Number(os.release().split(".")[0]) < 24
    ) {
      throw new SandboxUnavailableError(
        "Seatbelt 后端要求 macOS 15 或更新版本。",
      );
    }

    if (process.getuid?.() === 0) {
      throw new SandboxUnavailableError(
        "MXC Agent Runtime 要求非 root 宿主用户。",
      );
    }

    signal.throwIfAborted();

    return {
      level: `${mxcExecutionMode(this.options.platform)}-mxc-v1`,
      workspaceProtection: "direct-path" as const,
    };
  }

  private async observe<T>(
    input: LaunchInput,
    stage: string,
    operation: () => Promise<T>,
  ) {
    const started = performance.now();
    const attributes = {
      executionInstanceId: input.identity.executionInstanceId,
      backend: mxcExecutionMode(this.options.platform),
    };
    const span = this.options.traces?.startSpan(input.identity.taskId, {
      name: `sandbox.mxc.${stage}`,
      category: "sandbox",
      track: "Sandbox broker",
      attributes,
    });
    this.options.log?.info({
      event: `sandbox.mxc.${stage}.started`,
      module: "sandbox",
      taskId: input.identity.taskId,
      ...attributes,
    });
    try {
      const result = await operation();
      this.options.traces?.endSpan(span, "ok");
      this.options.log?.info({
        event: `sandbox.mxc.${stage}.completed`,
        module: "sandbox",
        taskId: input.identity.taskId,
        durationMs: Math.round(performance.now() - started),
        ...attributes,
      });

      return result;
    } catch (error) {
      this.options.traces?.endSpan(
        span,
        input.signal.aborted ? "cancelled" : "error",
      );
      this.options.log?.warn({
        event: `sandbox.mxc.${stage}.failed`,
        module: "sandbox",
        taskId: input.identity.taskId,
        durationMs: Math.round(performance.now() - started),
        errorName: error instanceof Error ? error.name : "Unknown",
        ...attributes,
      });
      throw error;
    }
  }

  async launchTask(input: LaunchInput): Promise<LaunchedAgentRuntime> {
    return this.observe(input, "launch", async () => {
      const frame = encodeRuntimeStartupDescriptor({
        protocolVersion: 1,
        identity: { ...input.identity, kind: "agent-runtime" },
        nonce: input.nonce,
      });
      const prepared = await this.observe(input, "preflight", async () => {
        await this.selfCheck(input.signal, {
          root: input.workspace,
          protectedPaths: [],
          protection: "direct-path",
        });
        const sdk = await (this.options.loadSdk?.() ??
          import("@microsoft/mxc-sdk/v1"));
        const backend =
          this.options.platform === "linux" ? "bubblewrap" : "seatbelt";
        if (!sdk.getPlatformSupport().availableMethods.includes(backend)) {
          throw new SandboxUnavailableError(
            "指定 MXC 后端不可用；不会退回宿主执行。",
          );
        }

        const workspace = await realpath(input.workspace);
        const node = await realpath(
          this.options.nodeExecutable ?? process.execPath,
        );
        const brokerData = await realpath(this.options.dataDirectory);
        if (!(await stat(workspace)).isDirectory()) {
          throw new Error("MXC 工作区必须是目录。");
        }

        const readRoots = await Promise.all(
          [
            path.dirname(path.dirname(node)),
            ...(this.options.readRoots ?? []),
          ].map((root) => realpath(root)),
        );
        const writeRoots = await Promise.all(
          (this.options.writeRoots ?? []).map((root) => realpath(root)),
        );
        assertDisjointRoots(
          [workspace, ...readRoots, ...writeRoots],
          [brokerData],
        );
        assertDisjointRoots([workspace, ...writeRoots], [node]);
        const bundle = await readMxcBundle(
          this.options.bundleDirectory ?? defaultMxcBundleDirectory(),
        );
        input.signal.throwIfAborted();

        return {
          sdk,
          workspace,
          node,
          brokerData,
          readRoots,
          writeRoots,
          bundle,
        };
      });
      const files = await prepareMxcFiles(
        prepared.bundle,
        this.journalDirectory,
      );
      let launching = false;
      let handle: MxcHandle | undefined;
      let launched: LaunchedAgentRuntime | undefined;
      try {
        assertDisjointRoots(
          [prepared.workspace, ...prepared.readRoots, ...prepared.writeRoots],
          [files.root],
        );
        input.signal.throwIfAborted();
        if (this.blocked) {
          throw new SandboxUnavailableError("并发 MXC 实例失败；停止新启动。");
        }

        await files.markLaunching(input.identity);
        launching = true;
        const pending = prepared.sdk.spawn(
          createMxcRequest({
            platform: this.options.platform,
            ...prepared,
            ...files,
          }),
        );
        // SDK 的 spawn 没有 AbortSignal。超时后保留标记，并为迟到的句柄安装回收器。
        try {
          handle = await bounded(
            pending,
            this.options.startupTimeoutMs ?? 30_000,
          );
        } catch (error) {
          void pending
            .then(async (late) => {
              const inputStream = late.standardInput;
              late.standardOutput?.resume();
              late.standardError?.resume();
              const exited = late.wait();
              void exited.catch(() => {});
              late.kill();
              inputStream?.destroy();
              await bounded(exited, this.options.cleanupTimeoutMs ?? 10_000);
              late.dispose();
            })
            .catch(() => {});
          throw error;
        }

        const output = handle.standardInput;
        const stream = handle.standardOutput;
        handle.standardError?.resume();
        const exited = handle.wait();
        void exited.catch(() => {});
        if (
          !output ||
          !stream ||
          !Number.isSafeInteger(handle.id) ||
          handle.id <= 0
        ) {
          handle.kill();
          await bounded(exited, this.options.cleanupTimeoutMs ?? 10_000);
          throw new Error("MXC 未交付有效的私有流或进程标识。");
        }

        let closing: Promise<"clean" | "orphaned"> | undefined;
        const child = handle;
        launched = {
          input: stream,
          output,
          pid: handle.id,
          pidKind: "runtime-launcher",
          mode: mxcExecutionMode(this.options.platform),
          close: (reason) => {
            closing ??= this.observe(input, "cleanup", async () => {
              try {
                child.kill();
                await bounded(exited, this.options.cleanupTimeoutMs ?? 10_000);
                child.dispose();
                stream.destroy();
                output.destroy();
                if (reason === "unknown") {
                  throw new Error("Runtime 终态未知，保留启动标记。");
                }

                await files.cleanup();

                return "clean" as const;
              } catch {
                this.blocked = true;
                throw new Error(
                  "MXC 清理/任务结果未知，已隔离并保留启动标记。",
                );
              } finally {
                this.active.delete(input.identity.executionInstanceId);
              }
            }).catch(() => "orphaned" as const);

            return closing;
          },
        };
        this.active.set(input.identity.executionInstanceId, launched);
        if (input.signal.aborted || this.blocked) {
          await launched.close("cancel");
          throw new Error("MXC 启动过程中已取消或隔离。");
        }

        // Node Writable 会在失败时发 error；即使 Engine 尚未接管流，也不能触发宿主未处理异常。
        output.on("error", () => stream.destroy());
        output.write(frame);

        return {
          ...launched,
          close: async (reason) => {
            const result = await launched!.close(reason);
            if (result !== "clean") {
              await this.drainOthers(input.identity.executionInstanceId);
            }

            return result;
          },
        };
      } catch (error) {
        if (
          launched &&
          input.signal.aborted &&
          (await launched.close("cancel")) === "clean"
        ) {
          throw input.signal.reason;
        }

        if (launching) {
          this.blocked = true;
          if (launched) {
            await launched.close("unknown");
          } else if (handle) {
            try {
              handle.kill();
            } catch {
              /* 不按 PID 重试。 */
            }
          }

          await this.drainOthers(input.identity.executionInstanceId);
        } else {
          await files.cleanup();
        }

        throw new SandboxUnavailableError(
          error instanceof SandboxUnavailableError
            ? error.message
            : "MXC 启动失败；未转为宿主执行，启动后的未知状态需核对。",
        );
      }
    });
  }

  private async drainOthers(except?: string) {
    await Promise.all(
      [...this.active]
        .filter(([id]) => id !== except)
        .map(([, child]) => child.close("unknown")),
    );
  }

  async shutdown() {
    this.blocked = true;
    await Promise.all(
      [...this.active.values()].map((child) => child.close("shutdown")),
    );
  }

  async execute(): Promise<{
    output: string;
    exitCode: number;
    truncated: boolean;
  }> {
    throw new SandboxUnavailableError(
      "MXC 只允许常驻 Agent Runtime，不接受逐命令宿主/Runner 旁路。",
    );
  }
}
