/**
 * Local overlay 发布协议 PoC，调用方提供实验协调目录、变更集与候选验证函数。
 * 1. publish 按真实来源身份获取跨进程独占锁；等待有界，未知/崩溃锁不自动删除。
 * 2. prepare 整批合并 B/O/T、保存来源备份和候选；验证后复核所有文件及已知读依赖。
 * 3. apply 记录逐文件 intent，再执行替换/删除；任何开始执行后的失败保留日志和锁。
 * 4. inspect 只比较现场与 before/after，不续写、不回滚、不释放未知锁。
 * 5. src/tracing 记录 queue/prepare/validate/apply 的 ID、耗时和安全终态，不含路径/正文。
 * 6. 显式 nativeWindows 使用保留 owner/group/DACL 的原生替换，完整发布后按身份清理备份。
 * 7. 可选 refresh 在来源 complete 后确认私有视图；失败保留 pending 收据，不重写来源完成状态。
 * 仅普通单链接文件/已存在父目录；新建使用不覆盖的 link，旧对照模式不保证 Windows ACL 保真。
 * 不提供外部写入 CAS、多文件原子提交、断电证明或生产服务集成；故障钩子仅供实验。
 */
import { mkdir, open, readFile, rename, unlink, link } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pino, { type Logger } from "pino";
import { TraceRecorder } from "../../src/tracing/recorder.js";
import type { TraceStatus } from "../../src/tracing/types.js";
import { canonical } from "../../src/tools/paths.js";
import {
  bytes,
  checkedPath,
  digest,
  durableJson,
  snapshot,
  sourceIdentity,
  type Snapshot,
} from "./files.js";
import { equal, mergeContent, PublishError } from "./merge.js";
import { validateBatch, type Batch } from "./session.js";
import { windowsReplace, windowsCleanup } from "./windows-publish.js";
import {
  validateOverlayAcknowledgement,
  type OverlayAcknowledgement,
} from "../../src/worktrees/overlay.js";

interface Entry {
  path: string;
  before: Snapshot;
  after: string | null;
  state: "pending" | "intent" | "written" | "unchanged";
  backup?: { path: string; identity?: string; cleaned?: boolean };
}

interface Journal {
  batch: Batch;
  state: "prepared" | "applying" | "complete" | "aborted" | "unknown";
  entries: Entry[];
  refresh?: { request: OverlayAcknowledgement; state: "pending" | "confirmed" };
}

export interface PublishOptions {
  validate: (files: ReadonlyMap<string, Buffer | null>) => Promise<void>;
  signal?: AbortSignal;
  lockTimeoutMs?: number;
  afterWrite?: (index: number) => Promise<void>;
  nativeWindows?: boolean;
  refresh?: {
    request: OverlayAcknowledgement;
    acknowledge: (request: OverlayAcknowledgement) => Promise<void>;
  };
}

function decode(value: string | null) {
  return value === null ? null : Buffer.from(value, "base64");
}

export class Publisher {
  private readonly traces = new TraceRecorder();

  constructor(
    readonly directory: string,
    private readonly log: Logger = pino({ enabled: false }),
  ) {}

  private async layout(batch: Batch) {
    const current = await sourceIdentity(batch.source.root);
    if (
      current.root !== batch.source.root ||
      current.identity !== batch.source.identity
    ) {
      throw new PublishError("SOURCE_REPLACED");
    }

    const control = await canonical(this.directory);
    const within = (parent: string, child: string) => {
      const relative = path.relative(parent, child);

      return (
        !relative ||
        (!relative.startsWith(".." + path.sep) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      );
    };

    if (within(current.root, control) || within(control, current.root)) {
      throw new PublishError("CONTROL_OVERLAP");
    }

    await mkdir(control, { recursive: true });
    const key = digest(
      current.identity +
        ":" +
        (process.platform === "win32"
          ? current.root.toLowerCase()
          : current.root),
    );
    const directory = path.join(control, key);
    await mkdir(directory, { recursive: true });

    return { directory, lock: path.join(directory, "publish.lock") };
  }

  private async acquire(file: string, options: PublishOptions) {
    const deadline = performance.now() + (options.lockTimeoutMs ?? 3000);
    const owner = { id: randomUUID(), pid: process.pid };
    for (;;) {
      options.signal?.throwIfAborted();
      let handle;
      try {
        handle = await open(file, "wx", 0o600);
      } catch (error: any) {
        if (error.code !== "EEXIST") {
          throw error;
        }

        if (performance.now() >= deadline) {
          throw new PublishError("LOCK_BUSY_OR_RECOVERY_REQUIRED");
        }

        await delay(20, undefined, { signal: options.signal });
        continue;
      }

      try {
        await handle.writeFile(JSON.stringify(owner));
        await handle.sync();
      } finally {
        await handle.close();
      }

      return async () => {
        const found = JSON.parse(await readFile(file, "utf8"));
        if (found.id !== owner.id) {
          throw new PublishError("LOCK_REPLACED");
        }

        await unlink(file);
      };
    }
  }

  private async prepare(batch: Batch): Promise<Journal> {
    const entries: Entry[] = [];
    for (const change of batch.changes) {
      const current = await snapshot(batch.source, change.path);
      if (
        current.mode !== null &&
        change.base.mode !== null &&
        current.mode !== change.base.mode
      ) {
        throw new PublishError("MODE_CONFLICT");
      }

      const after = mergeContent(
        bytes(change.base),
        decode(change.ours),
        bytes(current),
      );
      entries.push({
        path: change.path,
        before: current,
        after: after?.toString("base64") ?? null,
        state: "pending",
      });
    }

    return { batch, entries, state: "prepared" };
  }

  private async verify(journal: Journal) {
    for (const entry of journal.entries) {
      if (
        (await snapshot(journal.batch.source, entry.path)).version !==
        entry.before.version
      ) {
        throw new PublishError("STALE_CANDIDATE");
      }
    }

    for (const read of journal.batch.reads) {
      if (
        (await snapshot(journal.batch.source, read.path)).version !==
        read.version
      ) {
        throw new PublishError("STALE_DEPENDENCY");
      }
    }
  }

  private async apply(journal: Journal, file: string, options: PublishOptions) {
    for (const [index, entry] of journal.entries.entries()) {
      options.signal?.throwIfAborted();
      const before = await snapshot(journal.batch.source, entry.path);
      if (before.version !== entry.before.version) {
        throw new PublishError("STALE_CANDIDATE");
      }

      if (equal(bytes(before), decode(entry.after))) {
        entry.state = "unchanged";
        await durableJson(file, journal);
        continue;
      }

      const target = await checkedPath(journal.batch.source, entry.path);
      const content = decode(entry.after);
      let temporary: string | undefined;
      if (content !== null) {
        temporary = path.join(
          path.dirname(target),
          `.codeatelier-publish-${journal.batch.id}-${index}.tmp`,
        );
        const handle = await open(temporary, "wx", before.mode ?? 0o600);
        try {
          await handle.writeFile(content);
          if (before.mode !== null) {
            await handle.chmod(before.mode);
          }

          await handle.sync();
        } finally {
          await handle.close();
        }
      }

      // Intent precedes the source side effect. An exit after rename and before
      // acknowledgement remains observable as unknown, never assumed absent.
      if (temporary && before.content !== null && options.nativeWindows) {
        entry.backup = {
          path: path.relative(journal.batch.source.root, temporary + ".backup"),
        };
      }

      entry.state = "intent";
      await durableJson(file, journal);
      if (
        (await snapshot(journal.batch.source, entry.path)).version !==
        before.version
      ) {
        throw new PublishError("STALE_CANDIDATE");
      }

      options.signal?.throwIfAborted();
      if (temporary) {
        if (before.content === null) {
          await link(temporary, target);
          await unlink(temporary);
        } else if (options.nativeWindows) {
          entry.backup!.identity = await windowsReplace(
            target,
            temporary,
            digest(bytes(before)!),
            digest(content!),
          );
        } else {
          await rename(temporary, target);
        }
      } else {
        await unlink(target);
      }

      await options.afterWrite?.(index);
      entry.state = "written";
      await durableJson(file, journal);
    }
  }

  private async cleanupBackups(journal: Journal, file: string) {
    let pending = 0;
    for (const entry of journal.entries) {
      if (!entry.backup?.identity) {
        continue;
      }

      try {
        await windowsCleanup(
          path.join(journal.batch.source.root, entry.backup.path),
          entry.backup.identity,
          digest(bytes(entry.before)!),
        );
        entry.backup.cleaned = true;
      } catch {
        pending++;
      }
    }

    try {
      await durableJson(file, journal);
    } catch {
      this.log.warn({
        module: "local-overlay-poc",
        event: "backup_cleanup_record_failed",
        batchId: journal.batch.id,
      });
    }

    if (pending) {
      this.log.warn({
        module: "local-overlay-poc",
        event: "backup_cleanup_pending",
        batchId: journal.batch.id,
        count: pending,
      });
    }

    return pending;
  }

  async publish(input: Batch, options: PublishOptions) {
    if (options.nativeWindows && process.platform !== "win32") {
      throw new PublishError("WINDOWS_REQUIRED");
    }

    const batch = validateBatch(input);
    if (options.refresh) {
      validateOverlayAcknowledgement(options.refresh.request);
    }

    if (
      options.refresh &&
      (options.refresh.request.batchId !== batch.id ||
        JSON.stringify(options.refresh.request.paths) !==
          JSON.stringify(
            batch.changes.map(
              (change) => "\\" + change.path.replaceAll("/", "\\"),
            ),
          ))
    ) {
      throw new PublishError("REFRESH_BATCH_MISMATCH");
    }

    const locations = await this.layout(batch);
    const task = randomUUID();
    const output = path.join(locations.directory, batch.id);
    this.traces.startTask(task, batch.id);
    let release: (() => Promise<void>) | undefined;
    let journal: Journal | undefined;
    let applying = false;
    let outcome: TraceStatus = "error";
    let reason: string | undefined;
    let outputCreated = false;
    const started = performance.now();
    this.log.info({
      module: "local-overlay-poc",
      event: "publish_started",
      batchId: batch.id,
      operationId: task,
    });
    const step = async <T>(
      name: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const span = this.traces.startSpan(task, {
        name: `local_overlay.${name}`,
        category: "workspace",
        track: "Local publication",
        attributes: { batchId: batch.id, fileCount: batch.changes.length },
      });
      try {
        const result = await operation();
        this.traces.endSpan(span, "ok");

        return result;
      } catch (error) {
        this.traces.endSpan(
          span,
          applying || name === "refresh"
            ? "unknown"
            : options.signal?.aborted
              ? "cancelled"
              : "error",
        );
        throw error;
      }
    };

    try {
      release = await step("queue", () =>
        this.acquire(locations.lock, options),
      );
      // One sealed batch has one attempt. Retrying requires explicit fresh reads,
      // a new batch ID, and independent inspection of any previous unknown state.
      await mkdir(output);
      outputCreated = true;
      journal = await step("prepare", () => this.prepare(batch));
      if (options.refresh) {
        journal.refresh = {
          request: structuredClone(options.refresh.request),
          state: "pending",
        };
      }

      await durableJson(path.join(output, "journal.json"), journal);
      await this.verify(journal);
      const candidates = new Map(
        journal.entries.map((entry) => [entry.path, decode(entry.after)]),
      );
      await step("validate", () => options.validate(candidates));
      options.signal?.throwIfAborted();
      await this.verify(journal);
      journal.state = "applying";
      await durableJson(path.join(output, "journal.json"), journal);
      applying = true;
      await step("apply", () =>
        this.apply(journal!, path.join(output, "journal.json"), options),
      );
      journal.state = "complete";
      await durableJson(path.join(output, "journal.json"), journal);
      applying = false;
      outcome = "ok";
      const cleanupPending = options.nativeWindows
        ? await step("cleanup", () =>
            this.cleanupBackups(journal!, path.join(output, "journal.json")),
          )
        : 0;
      let refreshPending = false;
      if (journal.refresh && options.refresh) {
        try {
          await step("refresh", async () => {
            await options.refresh!.acknowledge(journal!.refresh!.request);
            journal!.refresh!.state = "confirmed";
            await durableJson(path.join(output, "journal.json"), journal);
          });
        } catch {
          refreshPending = true;
          this.log.warn({
            module: "local-overlay-poc",
            event: "view_refresh_pending",
            batchId: batch.id,
          });
        }
      }

      return {
        directory: output,
        files: journal.entries.length,
        cleanupPending,
        refreshPending,
      };
    } catch (error) {
      reason = error instanceof PublishError ? error.code : "OPERATION_FAILED";
      outcome = applying
        ? "unknown"
        : options.signal?.aborted
          ? "cancelled"
          : "error";
      if (journal) {
        journal.state = applying ? "unknown" : "aborted";
        await durableJson(path.join(output, "journal.json"), journal);
      }

      throw error;
    } finally {
      try {
        if (!applying) {
          await release?.();
        }
      } catch (error) {
        outcome = "unknown";
        throw error;
      } finally {
        this.traces.finishTask(task, outcome);
        if (outputCreated) {
          try {
            await durableJson(
              path.join(output, "trace.json"),
              this.traces.exportTask(task),
            );
          } catch {
            this.log.warn({
              module: "local-overlay-poc",
              event: "trace_failed",
              batchId: batch.id,
            });
          }
        }

        this.traces.discardTask(task);
        this.log.info({
          module: "local-overlay-poc",
          event: "publish_finished",
          batchId: batch.id,
          operationId: task,
          outcome,
          reason,
          durationMs: performance.now() - started,
        });
      }
    }
  }

  async inspect(input: Batch) {
    const batch = validateBatch(input);
    const locations = await this.layout(batch);
    const journal = JSON.parse(
      await readFile(
        path.join(locations.directory, batch.id, "journal.json"),
        "utf8",
      ),
    ) as Journal;
    const results = [];
    for (const entry of journal.entries) {
      const current = await snapshot(batch.source, entry.path);
      const observed = equal(bytes(current), decode(entry.after))
        ? "matches_after"
        : current.version === entry.before.version
          ? "matches_before"
          : "diverged";
      results.push({ path: entry.path, recorded: entry.state, observed });
    }

    return { state: journal.state, files: results };
  }
}
