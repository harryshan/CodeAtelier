/**
 * 管理 WinFsp 长驻挂载进程，供 WorktreeService 创建/验证/关闭使用。
 * 1. 固定本机 UNC 命名空间和可信 helper 路径；能力探测由 riftri.ts 统一处理。
 * 2. start 等待有界协议 ready，stdin 生命周期绑定宿主；同一 ID 去重，异常退出后本进程内不重挂载。
 * 3. stop 在任务排空后关闭 stdin，等待停止/退出；超时仅终止自己创建的 helper，保留磁盘现场。
 * 4. mount/restore/unmount/异常退出记录独立 trace 和受控生命周期日志，原生诊断只含状态码/源码行号。
 * 5. 显式 gitBase 仅供人工虚拟 worktree PoC；metrics 读取累计计数/微秒耗时及可选 lower 导入提交数，兼容旧 helper 收据。
 * 6. Local 模式要求独立策略收据，挂载身份/策略固定；旧模式保持私有 gitfile 兼容。
 * 7. withFrozen 停止 Local 文件系统服务后执行导出，helper 全程持有控制目录租约；返回后正常退出。
 *    同一冻结回调可确认已完成的来源发布；仅匹配批次/代次收据成功后允许调用方记录视图已刷新。
 * 8. 冻结回调接收租约失效/取消信号；关闭先中止并等待回调排空，再幂等卸载，不用竞速伪造完成。
 *    导出回调可复核原生读版本；协议只回执状态，不通过 stdout 传文件内容或路径。
 * 9. 冻结回调可显式 collect 无引用内容；独立于发布确认，仅记录计数，不改变来源或恢复收据。
 * 10. nextEpoch 按请求/旧代次/seal 等待幂等收据，只开启新观察周期；不发布或删除失败轮次修改。
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
  lowerImportCommits: z.number().int().nonnegative().optional(),
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

const collectionSchema = z.object({
  version: z.literal(1),
  state: z.literal("collected"),
  mode: z.literal("local"),
  nodes: z.number().int().nonnegative(),
  examined: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
});
export type OverlayCollection = z.infer<typeof collectionSchema>;

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
  collected?: (result: OverlayCollection) => void;
  epochAdvanced?: OverlayEpochTransition & { resolve: () => void };
  frozenScope?: { controller: AbortController; drained: Promise<void> };
  shutdown?: Promise<void>;
  acknowledgement?: {
    batchId: string;
    epoch: number;
    seal: string;
    resolve: () => void;
  };
  metrics?: (value: OverlayMetrics) => void;
}

const acknowledgementSchema = z.object({
  batchId: z.uuid(),
  seal: z.uuid(),
  epoch: z.number().int().min(0).max(1_000_000_000),
  paths: z.array(z.string().min(2).max(4096)).min(1).max(100),
});
export type OverlayAcknowledgement = z.infer<typeof acknowledgementSchema>;

const epochTransitionSchema = z.object({
  requestId: z.uuid(),
  seal: z.uuid(),
  epoch: z.number().int().min(0).max(999_999_999),
});
export type OverlayEpochTransition = z.infer<typeof epochTransitionSchema>;

/** Validate before source publication too: a known oversized refresh request
 * must not be discovered only after the source has already been changed. */
export function validateOverlayAcknowledgement(input: unknown) {
  const request = acknowledgementSchema.parse(input);
  let encodedLength = 0;
  for (const value of request.paths) {
    if (!value.startsWith("\\") || /[\x00-\x1f]/.test(value)) {
      throw new Error("Invalid acknowledgement path.");
    }

    encodedLength += Buffer.byteLength(value, "utf8") * 2 + 1;
  }

  if (encodedLength + 100 > 1024 * 1024) {
    throw new Error("Acknowledgement request exceeds limit.");
  }

  return request;
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
    let outcome: "ok" | "error" | "cancelled" | "unknown" =
      action === "local_acknowledge" ||
      action === "local_collect" ||
      action === "local_next_epoch"
        ? "unknown"
        : "error";
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
          mount.frozenScope?.controller.abort(
            new Error("Overlay frozen lease failed."),
          );
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
              const collection = collectionSchema.safeParse(raw);
              if (collection.success) {
                if (!local || !mount.collected) {
                  throw new Error("Unexpected collection receipt.");
                }

                mount.collected(collection.data);
                continue;
              }

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
                    "acknowledged",
                    "epoch-advanced",
                  ]),
                  mode: z.literal("local").optional(),
                  batchId: z.uuid().optional(),
                  requestId: z.uuid().optional(),
                  seal: z.uuid().optional(),
                  epoch: z.number().int().optional(),
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
              } else if (message.state === "epoch-advanced") {
                const pending = mount.epochAdvanced;
                if (
                  !local ||
                  !pending ||
                  message.mode !== "local" ||
                  message.requestId !== pending.requestId ||
                  message.seal !== pending.seal ||
                  message.epoch !== pending.epoch + 1
                ) {
                  throw new Error("Unexpected epoch transition receipt.");
                }

                pending.resolve();
              } else if (message.state === "acknowledged") {
                const pending = mount.acknowledgement;
                if (
                  !local ||
                  !pending ||
                  message.mode !== "local" ||
                  message.batchId !== pending.batchId ||
                  message.seal !== pending.seal ||
                  message.epoch !== pending.epoch + 1
                ) {
                  throw new Error("Unexpected publication acknowledgement.");
                }

                pending.resolve();
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

  private async verifyFrozenReads(mount: Mount, epochs?: readonly number[]) {
    const requested =
      epochs === undefined
        ? []
        : z
            .array(z.number().int().min(0).max(1_000_000_000))
            .min(1)
            .max(100)
            .parse(epochs);
    if (
      mount.epochAdvanced ||
      mount.collected ||
      mount.readsChecked ||
      mount.acknowledgement ||
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
            () => reject(new Error("Frozen read verification timed out.")),
            30_000,
          );
          mount.process.stdin.write(
            `check-reads${requested.length ? " " + requested.join(" ") : ""}\n`,
          );
        }),
        mount.exit.then(() => {
          throw new Error("Overlay lease was lost during read verification.");
        }),
      ]);
    } finally {
      clearTimeout(readTimer);
      mount.readsChecked = undefined;
    }
  }

  private async acknowledgeFrozen(
    id: string,
    mount: Mount,
    input: OverlayAcknowledgement,
  ) {
    const request = validateOverlayAcknowledgement(input);
    if (
      mount.epochAdvanced ||
      mount.collected ||
      mount.readsChecked ||
      mount.acknowledgement ||
      mount.failed ||
      mount.stopping ||
      mount.closed
    ) {
      throw new Error("Frozen acknowledgement unavailable.");
    }

    const encoded = request.paths.map((value) =>
      Buffer.from(value, "utf8").toString("hex"),
    );
    const command = `acknowledge ${request.batchId} ${request.epoch} ${request.seal} ${encoded.join(" ")}\n`;
    if (command.length > 1024 * 1024) {
      throw new Error("Acknowledgement request exceeds limit.");
    }

    await this.observe(id, "local_acknowledge", async () => {
      let ackTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            mount.acknowledgement = { ...request, resolve };
            ackTimer = setTimeout(
              () => reject(new Error("Publication acknowledgement timed out.")),
              30_000,
            );
            mount.process.stdin.write(command);
          }),
          mount.exit.then(() => {
            throw new Error("Overlay lease was lost during acknowledgement.");
          }),
        ]);
        if (mount.failed || mount.closed || mount.stopping) {
          throw new Error("Publication acknowledgement was not confirmed.");
        }
      } finally {
        clearTimeout(ackTimer);
        mount.acknowledgement = undefined;
      }
    });
  }

  private async collectFrozen(id: string, mount: Mount) {
    if (
      mount.epochAdvanced ||
      mount.collected ||
      mount.readsChecked ||
      mount.acknowledgement ||
      mount.failed ||
      mount.stopping ||
      mount.closed
    ) {
      throw new Error("Frozen collection unavailable.");
    }

    return this.observe(id, "local_collect", async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          new Promise<OverlayCollection>((resolve, reject) => {
            mount.collected = resolve;
            timer = setTimeout(() => {
              // A late receipt must not satisfy a later collection request.
              mount.failed = true;
              mount.frozenScope?.controller.abort(
                new Error("Collection timed out."),
              );
              reject(new Error("Collection timed out."));
            }, 30_000);
            mount.process.stdin.write("collect\n");
          }),
          mount.exit.then(() => {
            throw new Error("Overlay lease was lost during collection.");
          }),
        ]);
        if (mount.failed || mount.closed || mount.stopping) {
          throw new Error("Collection was not confirmed.");
        }

        this.log.info({
          module: "worktree",
          event: "overlay.local_collect_counts",
          worktreeId: id,
          nodes: result.nodes,
          examined: result.examined,
          removed: result.removed,
          bytes: result.bytes,
          retained: result.retained,
        });

        return result;
      } finally {
        clearTimeout(timer);
        mount.collected = undefined;
      }
    });
  }

  private async advanceFrozenEpoch(
    id: string,
    mount: Mount,
    input: OverlayEpochTransition,
  ) {
    const request = epochTransitionSchema.parse(input);
    if (
      mount.epochAdvanced ||
      mount.collected ||
      mount.readsChecked ||
      mount.acknowledgement ||
      mount.failed ||
      mount.stopping ||
      mount.closed
    ) {
      throw new Error("Frozen epoch transition unavailable.");
    }

    await this.observe(id, "local_next_epoch", async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            mount.epochAdvanced = { ...request, resolve };
            timer = setTimeout(() => {
              mount.failed = true;
              mount.frozenScope?.controller.abort(
                new Error("Epoch transition timed out."),
              );
              reject(new Error("Epoch transition timed out."));
            }, 30_000);
            mount.process.stdin.write(
              `next-epoch ${request.requestId} ${request.epoch} ${request.seal}\n`,
            );
          }),
          mount.exit.then(() => {
            throw new Error("Overlay lease was lost during epoch transition.");
          }),
        ]);
        if (mount.failed || mount.closed || mount.stopping) {
          throw new Error("Epoch transition was not confirmed.");
        }
      } finally {
        clearTimeout(timer);
        mount.epochAdvanced = undefined;
      }
    });
  }

  /** Caller drains its task processes first. Export runs only after the native
   * volume disappears, while the helper still excludes other store owners. */
  async withFrozen<T>(
    id: string,
    exportChanges: (
      verifyReads: (epochs?: readonly number[]) => Promise<void>,
      acknowledge: (request: OverlayAcknowledgement) => Promise<void>,
      signal: AbortSignal,
      collect: () => Promise<OverlayCollection>,
      nextEpoch: (request: OverlayEpochTransition) => Promise<void>,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const mount = this.mounts.get(id);
    if (!mount?.local || mount.failed || mount.stopping || mount.freezing) {
      throw new Error("Local overlay cannot be frozen in its current state.");
    }

    signal?.throwIfAborted();

    mount.freezing = true;
    const controller = new AbortController();
    let resolveDrained!: () => void;
    const scope = {
      controller,
      drained: new Promise<void>((resolve) => {
        resolveDrained = resolve;
      }),
    };
    mount.frozenScope = scope;
    const abort = () =>
      controller.abort(
        signal?.reason ?? new Error("Frozen operation cancelled."),
      );
    signal?.addEventListener("abort", abort, { once: true });
    void mount.exit.then(() => {
      if (mount.frozenScope === scope) {
        controller.abort(new Error("Overlay frozen lease exited."));
      }
    });

    return this.observe(
      id,
      "local_freeze",
      async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rejectFreeze: ((reason: unknown) => void) | undefined;
        const abortFreeze = () => rejectFreeze?.(controller.signal.reason);
        controller.signal.addEventListener("abort", abortFreeze, {
          once: true,
        });
        try {
          controller.signal.throwIfAborted();
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              mount.freeze = resolve;
              timer = setTimeout(
                () => reject(new Error("Local overlay freeze timed out.")),
                30_000,
              );
              mount.process.stdin.write("freeze\n");
            }),
            new Promise<never>((_resolve, reject) => {
              rejectFreeze = reject;
              if (controller.signal.aborted) {
                reject(controller.signal.reason);
              }
            }),
          ]);
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", abortFreeze);
          controller.signal.throwIfAborted();
          if (mount.failed || mount.closed) {
            throw new Error("Overlay freeze was not confirmed.");
          }

          // A rejected race cannot stop the callback. Keep ownership of its
          // lifetime until it has observed cancellation and settled its effects.
          const result = await exportChanges(
            async (epochs) => {
              controller.signal.throwIfAborted();
              await this.verifyFrozenReads(mount, epochs);
            },
            async (request) => {
              controller.signal.throwIfAborted();
              await this.acknowledgeFrozen(id, mount, request);
            },
            controller.signal,
            async () => {
              controller.signal.throwIfAborted();

              return this.collectFrozen(id, mount);
            },
            async (request) => {
              controller.signal.throwIfAborted();
              await this.advanceFrozenEpoch(id, mount, request);
            },
          );
          controller.signal.throwIfAborted();
          if (mount.failed || mount.closed || mount.stopping) {
            throw new Error("Overlay lease was lost during frozen export.");
          }

          return result;
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", abortFreeze);
          signal?.removeEventListener("abort", abort);
          controller.abort(new Error("Frozen scope ended."));
          mount.freeze = undefined;
          mount.frozenScope = undefined;
          resolveDrained();
          await this.stop(id);
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

    if (mount.frozenScope) {
      const scope = mount.frozenScope;
      scope.controller.abort(new Error("Overlay manager is closing."));
      await scope.drained;
    }

    if (mount.closed && mount.stopped && mount.exitCode === 0) {
      return;
    }

    mount.shutdown ??= this.observe(id, "unmount", async () => {
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
    await mount.shutdown;
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
