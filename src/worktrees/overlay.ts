/**
 * 管理 WinFsp 长驻挂载进程，供 WorktreeService 创建/验证/关闭使用。
 * 1. 固定本机 UNC 命名空间和可信 helper 路径；能力探测由 riftri.ts 统一处理。
 * 2. start 等待有界协议 ready，stdin 生命周期绑定宿主；同一 ID 去重，异常退出后本进程内不重挂载。
 * 3. stop 在任务排空后关闭 stdin，等待停止/退出；超时仅终止自己创建的 helper，保留磁盘现场。
 * 4. mount/restore/unmount/异常退出记录独立 trace 和受控生命周期日志，原生诊断只含状态码/源码行号。
 * 5. 显式 gitBase 仅供人工虚拟 worktree PoC；metrics 读取累计计数/微秒耗时，兼容旧 helper 收据。
 * 6. Local 模式要求独立策略收据，挂载身份/策略固定；旧模式保持私有 gitfile 兼容。
 * 7. withFrozen 停止 Local 文件系统服务后执行导出，helper 全程持有控制目录租约；返回后正常退出。
 *    导出回调可复核原生读版本；协议只回执状态，不通过 stdout 传文件内容或路径。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";
import { gitEnvironment } from "./git.js";

export interface GitOverlayBase {
  executable: string;
  directory: string;
  tree: string;
}

const metricsSchema = z.object({
  version: z.literal(1),
  state: z.literal("metrics"),
  treeReads: z.number().int().nonnegative(),
  infoReads: z.number().int().nonnegative(),
  blobReads: z.number().int().nonnegative(),
  blobBytes: z.number().int().nonnegative(),
  lowerOpens: z.number().int().nonnegative(),
  lowerEnumerations: z.number().int().nonnegative(),
  objectMicros: z.number().int().nonnegative().optional(),
  sqlPrepareMicros: z.number().int().nonnegative().optional(),
  sqlReadMicros: z.number().int().nonnegative().optional(),
  sqlWriteMicros: z.number().int().nonnegative().optional(),
  sqlExecMicros: z.number().int().nonnegative().optional(),
  sqlReads: z.number().int().nonnegative().optional(),
  sqlWrites: z.number().int().nonnegative().optional(),
  accessCleanups: z.number().int().nonnegative().optional(),
});
export type OverlayMetrics = z.infer<typeof metricsSchema>;

export function overlayHelperPath() {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? `../../dist/native/win32-${process.arch}/codeatelier-overlay.exe`
        : `../../native/win32-${process.arch}/codeatelier-overlay.exe`,
      import.meta.url,
    ),
  );
}

export function overlayNamespace(directory: string) {
  return createHash("sha256")
    .update(path.resolve(directory).toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

export function overlayWorkspace(namespace: string, id: string) {
  return `\\\\CodeAtelier\\${namespace}-${z.uuid().parse(id)}\\`;
}

export function overlayWorkspaceId(namespace: string, workspace: string) {
  const normalized = workspace.replaceAll("/", "\\");
  const prefix = `\\\\CodeAtelier\\${namespace}-`;
  if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
    return undefined;
  }

  const id = normalized.slice(prefix.length).replace(/\\$/, "");
  if (!z.uuid().safeParse(id).success) {
    throw new Error("不能将托管 overlay 子目录用作新工作区。");
  }

  return id;
}

interface Mount {
  identity: string;
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  exit: Promise<void>;
  failed: boolean;
  stopping: boolean;
  stopped: boolean;
  exitCode?: number | null;
  closed: boolean;
  gitLower: boolean;
  local: boolean;
  freezing?: boolean;
  freeze?: () => void;
  readsChecked?: () => void;
  metrics?: (value: OverlayMetrics) => void;
}

export class OverlayManager {
  private readonly mounts = new Map<string, Mount>();
  private readonly traces = new TraceRecorder();
  private readonly archive: TraceArchive;

  constructor(
    directory: string,
    private readonly log: Logger,
    private readonly executable = overlayHelperPath(),
  ) {
    this.archive = new TraceArchive(directory, log);
  }

  private async observe<T>(
    id: string,
    action: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ) {
    const operationId = randomUUID();
    this.traces.startTask(operationId, id);
    const span = this.traces.startSpan(operationId, {
      name: `overlay.${action}`,
      category: "worktree",
      track: "Overlay mounts",
      attributes: { worktreeId: id },
    });
    const started = performance.now();
    let outcome: "ok" | "error" | "cancelled" = "error";
    this.log.info({
      module: "worktree",
      event: `overlay.${action}_started`,
      worktreeId: id,
      operationId,
    });
    try {
      const result = await operation();
      outcome = "ok";

      return result;
    } finally {
      if (signal?.aborted) {
        outcome = "cancelled";
      }

      this.traces.endSpan(span, outcome);
      this.traces.finishTask(operationId, outcome);
      await this.archive.write(
        id,
        operationId,
        this.traces.exportTask(operationId),
      );
      this.traces.discardTask(operationId);
      this.log.info({
        module: "worktree",
        event: `overlay.${action}_finished`,
        worktreeId: id,
        operationId,
        outcome,
        durationMs: performance.now() - started,
      });
    }
  }

  async start(
    id: string,
    source: string,
    control: string,
    workspace: string,
    create: boolean,
    signal: AbortSignal,
    base?: GitOverlayBase | { kind: "local" },
  ) {
    const local = base !== undefined && "kind" in base;
    const gitBase = base !== undefined && !("kind" in base) ? base : undefined;
    const identity = JSON.stringify([source, control, workspace, base ?? null]);
    const existing = this.mounts.get(id);
    if (existing) {
      if (existing.identity !== identity) {
        throw new Error("Overlay 挂载身份或策略不匹配；不能复用另一个视图。");
      }

      await existing.ready;
      if (existing.failed || existing.stopping || existing.freezing) {
        throw new Error(
          "Overlay 已失去挂载；保留现场，请停止任务并重启服务检查。",
        );
      }

      return;
    }

    return this.observe(
      id,
      local
        ? create
          ? "local_mount"
          : "local_restore"
        : gitBase
          ? create
            ? "git_mount"
            : "git_restore"
          : create
            ? "mount"
            : "restore",
      async () => {
        signal.throwIfAborted();
        const child = spawn(
          this.executable,
          [
            (create ? "create" : "restore") +
              (local ? "-local" : gitBase ? "-git" : ""),
            source,
            control,
            workspace.slice(1).replace(/\\$/, ""),
            ...(gitBase
              ? [
                  gitBase.executable,
                  gitBase.directory,
                  z
                    .string()
                    .regex(/^[a-f0-9]{40}$/)
                    .parse(gitBase.tree),
                ]
              : []),
          ],
          {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            ...(gitBase
              ? {
                  env: {
                    ...process.env,
                    ...gitEnvironment(),
                    GIT_NO_LAZY_FETCH: "1",
                    GIT_NO_REPLACE_OBJECTS: "1",
                  },
                }
              : {}),
          },
        );
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        let resolveExit!: () => void;
        const exit = new Promise<void>((resolve) => {
          resolveExit = resolve;
        });
        const mount: Mount = {
          identity,
          process: child,
          ready,
          exit,
          failed: false,
          stopping: false,
          stopped: false,
          closed: false,
          gitLower: gitBase !== undefined,
          local,
        };
        this.mounts.set(id, mount);
        let buffer = "";
        const fail = () => {
          mount.failed = true;
          rejectReady(
            new Error(
              "Overlay helper 启动失败或异常退出；保留现场，不自动重放。",
            ),
          );
        };

        child.on("error", () => {
          fail();
          resolveExit();
        });
        child.on("close", (code) => {
          mount.exitCode = code;
          mount.closed = true;
          if (!mount.stopping) {
            fail();
            this.log.warn({
              module: "worktree",
              event: "overlay.unexpected_exit",
              worktreeId: id,
            });
            void this.observe(id, "unexpected_exit", async () => {
              throw new Error("Overlay helper exited unexpectedly.");
            }).catch(() => {});
          }

          resolveExit();
        });
        child.stdin.on("error", () => {
          if (!mount.stopping) {
            fail();
          }
        });
        let diagnostics = "";
        child.stderr.on("data", (bytes: Buffer) => {
          diagnostics = (diagnostics + bytes.toString("utf8")).slice(-4096);
          for (;;) {
            const end = diagnostics.indexOf("\n");
            if (end < 0) {
              break;
            }

            const line = diagnostics.slice(0, end).trim();
            diagnostics = diagnostics.slice(end + 1);
            const match =
              /^OVERLAY_(IO|CLEANUP)_ERROR (?:line=(\d+) )?status=(\d+)$/.exec(
                line,
              );
            if (match) {
              const report =
                match[1] === "CLEANUP"
                  ? this.log.warn.bind(this.log)
                  : this.log.debug.bind(this.log);
              report({
                module: "worktree",
                event: "overlay.native_error",
                worktreeId: id,
                operation: match[1],
                nativeLine: Number(match[2] ?? 0),
                nativeStatus: Number(match[3]),
              });
            }
          }
        });
        child.stdout.on("data", (bytes: Buffer) => {
          buffer += bytes.toString("utf8");
          if (buffer.length > 8192) {
            fail();
            child.kill();

            return;
          }

          for (;;) {
            const lineEnd = buffer.indexOf("\n");
            if (lineEnd < 0) {
              return;
            }

            const line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 1);
            try {
              const raw: unknown = JSON.parse(line);
              const metrics = metricsSchema.safeParse(raw);
              if (metrics.success) {
                mount.metrics?.(metrics.data);
                continue;
              }

              const message = z
                .object({
                  version: z.literal(1),
                  state: z.enum([
                    "ready",
                    "stopped",
                    "frozen",
                    "reads-checked",
                  ]),
                  mode: z.literal("local").optional(),
                })
                .parse(raw);
              if (message.state === "ready") {
                if (local !== (message.mode === "local")) {
                  rejectReady(
                    new Error(
                      "Overlay helper 策略不匹配；拒绝使用旧文件视图。",
                    ),
                  );
                  mount.failed = true;
                  child.stdin.end();
                  continue;
                }

                resolveReady();
              } else if (message.state === "reads-checked") {
                if (!local || !mount.readsChecked || message.mode !== "local") {
                  throw new Error("Unexpected read verification receipt.");
                }

                mount.readsChecked();
              } else if (message.state === "frozen") {
                if (!local || !mount.freezing || message.mode !== "local") {
                  throw new Error("Unexpected freeze receipt.");
                }

                mount.freeze?.();
              } else {
                mount.stopped = true;
              }
            } catch {
              fail();
              child.stdin.end();
            }
          }
        });
        const abort = () => {
          fail();
          child.stdin.end();
        };

        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
          fail();
          child.stdin.end();
        }, 30_000);
        try {
          await ready;
          signal.throwIfAborted();
          if (mount.failed) {
            throw new Error("Overlay 在就绪期间退出。");
          }
        } catch (error) {
          await this.stop(id);
          throw error;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      },
      signal,
    );
  }

  /** Read native PoC counters without enumerating the mounted working tree. */
  async metrics(id: string): Promise<OverlayMetrics> {
    const mount = this.mounts.get(id);
    if (
      !mount ||
      (!mount.gitLower && !mount.local) ||
      mount.failed ||
      mount.stopping ||
      mount.freezing ||
      mount.metrics
    ) {
      throw new Error("Overlay metrics unavailable or already pending.");
    }

    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<OverlayMetrics>((resolve, reject) => {
        mount.metrics = resolve;
        timer = setTimeout(
          () => reject(new Error("Overlay metrics timed out.")),
          30_000,
        );
        mount.process.stdin.write("metrics\n");
      });
    } finally {
      clearTimeout(timer!);
      mount.metrics = undefined;
    }
  }

  /** Caller drains its task processes first. Export runs only after the native
   * volume disappears, while the helper still excludes other store owners. */
  async withFrozen<T>(
    id: string,
    exportChanges: (verifyReads: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const mount = this.mounts.get(id);
    if (!mount?.local || mount.failed || mount.stopping || mount.freezing) {
      throw new Error("Local overlay cannot be frozen in its current state.");
    }

    mount.freezing = true;

    return this.observe(id, "local_freeze", async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            mount.freeze = resolve;
            timer = setTimeout(
              () => reject(new Error("Local overlay freeze timed out.")),
              30_000,
            );
            mount.process.stdin.write("freeze\n");
          }),
          mount.exit.then(() => {
            throw new Error("Overlay exited before frozen export completed.");
          }),
        ]);
        if (mount.failed || mount.closed) {
          throw new Error("Overlay freeze was not confirmed.");
        }

        const result = await Promise.race([
          exportChanges(async () => {
            if (
              mount.readsChecked ||
              mount.failed ||
              mount.stopping ||
              mount.closed
            ) {
              throw new Error("Frozen read verification unavailable.");
            }

            let readTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                new Promise<void>((resolve, reject) => {
                  mount.readsChecked = resolve;
                  readTimer = setTimeout(
                    () =>
                      reject(new Error("Frozen read verification timed out.")),
                    30_000,
                  );
                  mount.process.stdin.write("check-reads\n");
                }),
                mount.exit.then(() => {
                  throw new Error(
                    "Overlay lease was lost during read verification.",
                  );
                }),
              ]);
            } finally {
              clearTimeout(readTimer);
              mount.readsChecked = undefined;
            }
          }),
          mount.exit.then(() => {
            throw new Error("Overlay lease was lost during frozen export.");
          }),
        ]);
        if (mount.failed || mount.closed || mount.stopping) {
          throw new Error("Overlay lease was lost during frozen export.");
        }

        return result;
      } finally {
        clearTimeout(timer);
        mount.freeze = undefined;
        await this.stop(id);
      }
    });
  }

  /** Release only a mount owned by this manager; creation failures keep their disk state. */
  async stop(id: string) {
    const mount = this.mounts.get(id);
    if (!mount) {
      return;
    }

    if (mount.closed && mount.stopped && mount.exitCode === 0) {
      return;
    }

    await this.observe(id, "unmount", async () => {
      mount.stopping = true;
      mount.process.stdin.end();
      const timer = setTimeout(() => mount.process.kill(), 10_000);
      let deadline: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          mount.exit,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Overlay 卸载未确认完成；保留现场。")),
              15_000,
            );
          }),
        ]);
        if (!mount.stopped || mount.exitCode !== 0) {
          throw new Error("Overlay 未正常卸载；保留现场，不自动重挂载。");
        }
      } finally {
        clearTimeout(timer);
        clearTimeout(deadline!);
      }
    });
  }

  async close() {
    const failures: unknown[] = [];
    for (const id of this.mounts.keys()) {
      try {
        await this.stop(id);
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, "Overlay 清理未全部完成。");
    }
  }
}
