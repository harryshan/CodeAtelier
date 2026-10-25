/**
 * 管理 WinFsp 长驻挂载进程，供 WorktreeService 创建/验证/关闭使用。
 * 1. 固定本机 UNC 命名空间和可信 helper 路径；能力探测由 riftri.ts 统一处理。
 * 2. start 等待有界协议 ready，stdin 生命周期绑定宿主；同一 ID 去重，异常退出后本进程内不重挂载。
 * 3. stop 在任务排空后关闭 stdin，等待停止/退出；超时仅终止自己创建的 helper，保留磁盘现场。
 * 4. mount/restore/unmount/异常退出记录独立 trace 和受控生命周期日志，原生诊断只含状态码/源码行号。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";

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
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  exit: Promise<void>;
  failed: boolean;
  stopping: boolean;
  stopped: boolean;
  exitCode?: number | null;
  closed: boolean;
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
  ) {
    const existing = this.mounts.get(id);
    if (existing) {
      await existing.ready;
      if (existing.failed || existing.stopping) {
        throw new Error(
          "Overlay 已失去挂载；保留现场，请停止任务并重启服务检查。",
        );
      }

      return;
    }

    return this.observe(
      id,
      create ? "mount" : "restore",
      async () => {
        signal.throwIfAborted();
        const child = spawn(
          this.executable,
          [
            create ? "create" : "restore",
            source,
            control,
            workspace.slice(1).replace(/\\$/, ""),
          ],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
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
          process: child,
          ready,
          exit,
          failed: false,
          stopping: false,
          stopped: false,
          closed: false,
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
              const message = z
                .object({
                  version: z.literal(1),
                  state: z.enum(["ready", "stopped"]),
                })
                .parse(JSON.parse(line));
              if (message.state === "ready") {
                resolveReady();
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
