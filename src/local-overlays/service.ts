/**
 * Engine 的 Local overlay 持久目录生命周期；独立于 WorktreeService 和 Git metadata。
 * 1. 有界清单、原子保存和逐视图锁绑定来源/控制/卷身份；未知状态不重新创建或抢占。
 * 2. create 先保存 preparing，再建立/关闭空视图，最后绑定会话；未知挂载保留现场，纯校验失败不污染已有状态。
 * 3. validate/projectWorkspace 不挂载，供 admission 和项目记忆使用；describe 只投影历史状态，损坏清单标为不可用；begin 才取得整个任务租约。
 * 4. lease.finish 在调用方排空后冻结续轮、回收、卸载并保存 ready；清理未知则隔离且保留锁。
 * 5. cancelCreation/close 与 Engine 关闭顺序配合；trace 只记录关联 ID、阶段/耗时/终态。
 * 6. select 把明确路径及可信候选验证器绑定当前任务，null 撤销本轮选择；取消/错误任务身份不能更改选择。
 *    仅成功且已排空的任务在冻结收尾中发布，选择不跨轮继承；模型入口由 Engine 转换，不能反序列化验证函数。
 * 7. review/reviewBatch 在 ready 视图锁内读取单文件/有界整组 B/O/T，不挂载或更改清单；关闭时取消并等待检查排空。
 * 8. continueResolution 用已审核版本建立新视图及参考材料，固定请求重试绑定父会话；不修改旧视图或清空依赖。
 * 9. publicationRecovery 从非本进程活动会话定位发布事故，原生来源租约控制审核/接受；不取得或删除私有视图残留锁，不把失败卷改为 ready。
 *    release-complete 仅释放有原生退出证明的完整批次来源锁，不能重放写入或影响后来发布者。
 * 10. reviewInterrupted 不取得或删除旧服务锁；原生离线租约证明旧 helper/owner 退出，只读取选定中断参考。
 * 11. 同清单 read/save 只在短 I/O 期间排队，避免 Windows 读句柄阻止 rename；不重试发布或改变磁盘锁语义。
 * 12. recoverPrivateRefresh 仅恢复有任务排空/关闭凭据的 complete 刷新；独立恢复锁保护原任务锁，失败不重写来源。
 *     成功后保存原任务 ID 供当前 UI 区分历史失败与已恢复视图，下一任务清除；不改历史任务终态。
 * 13. withSandboxRecoveryRoots 只在账户已排空后的启动撤销阶段暴露已知卷根 ACL；保留 dirty/任务锁/阶段，不执行任务或发布。
 * 公开创建由 HTTP 单独检查平台/Sandbox 能力，不迁移旧历史；来源写入只由冻结租约内的协调器执行。
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { Session, TaskStatus } from "../shared/types.js";
import { directoryIdentity } from "../worktrees/git.js";
import { inside } from "../tools/paths.js";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";
import {
  publicationSelection,
  publicationStateSchema,
  type PublicationSelection,
} from "./publication.js";
import {
  WinFspLocalBackend,
  type LocalOverlayBackend,
  type LocalOverlayMount,
} from "./backend.js";
import {
  reviewCleanFile,
  reviewCleanFiles,
  reviewSelection,
  type LocalFileReview,
  type LocalReviewBatch,
} from "./publication/review.js";
import {
  sourceIdentity,
  checkRelative,
  type Source,
} from "./publication/files.js";
import { Publisher } from "./publication/publisher.js";
import { ManifestQueue } from "./manifest-queue.js";
import { withLocalInspection } from "./inspection-lease.js";
import { PublishError } from "./publication/merge.js";
import {
  inspectInterruptedFiles,
  type InterruptedReview,
} from "./interrupted-review.js";
import {
  resolutionOriginSchema,
  resolutionDirectory,
  resolutionPaths,
  seedResolution,
  type ResolutionOrigin,
} from "./resolution.js";

const recordSchema = z.object({
  version: z.literal(1),
  format: z.literal(6),
  id: z.uuid(),
  source: z.string(),
  sourceIdentity: z.string(),
  phase: z.enum(["preparing", "ready", "active", "failed"]),
  sessionId: z.uuid().optional(),
  controlIdentity: z.string().optional(),
  workspaceIdentity: z.string().optional(),
  taskId: z.uuid().optional(),
  outcome: z
    .enum(["completed", "failed", "cancelled", "interrupted"])
    .optional(),
  epoch: z.number().int().nonnegative().optional(),
  capturedPaths: z.number().int().nonnegative().optional(),
  publication: publicationStateSchema.optional(),
  resolution: resolutionOriginSchema.optional(),
  refreshRecovery: z.object({ taskId: z.uuid(), batchId: z.uuid() }).optional(),
  refreshedTaskId: z.uuid().optional(),
});
export type LocalOverlayRecord = z.infer<typeof recordSchema>;
export interface LocalOverlayLease {
  finish(status: TaskStatus, drained: boolean): Promise<LocalOverlayRecord>;
}

type ResolutionRequest = {
  id: string;
  workspace: string;
  sessionId: string;
  version: string;
} & ({ path: string } | { paths: readonly string[]; state?: "interrupted" });

export class LocalOverlayService {
  readonly root: string;
  private readonly backend: LocalOverlayBackend;
  private readonly creation = new AbortController();
  private readonly creating = new Set<Promise<unknown>>();
  private readonly active = new Set<string>();
  private readonly tasks = new Map<
    string,
    { taskId: string; finishing: boolean; selection?: PublicationSelection }
  >();

  private readonly traces = new TraceRecorder();
  private readonly manifests = new ManifestQueue();
  private readonly archive: TraceArchive;

  constructor(
    private readonly directory: string,
    private readonly log: Logger,
    backend?: LocalOverlayBackend,
  ) {
    this.root = path.resolve(directory, "local-overlays");
    this.backend = backend ?? new WinFspLocalBackend(this.root, log);
    this.archive = new TraceArchive(this.root, log);
  }

  private file(id: string) {
    return path.join(this.root, `${z.uuid().parse(id)}.json`);
  }

  private control(id: string) {
    return path.join(this.root, z.uuid().parse(id));
  }

  private read(id: string) {
    return this.manifests.run(id, () => this.readManifest(id));
  }

  private async readManifest(id: string) {
    const file = this.file(id);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 65536
    ) {
      throw new Error("Local overlay 清单类型或大小无效。");
    }

    const handle = await open(file, "r");
    let text: string;
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        opened.size !== info.size
      ) {
        throw new Error("Local overlay 清单读取期间改变。");
      }

      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== info.size) {
        throw new Error("Local overlay 清单读取不完整或大小改变。");
      }

      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }

    const record = recordSchema.parse(JSON.parse(text));
    if (record.id !== id) {
      throw new Error("Local overlay 清单身份不匹配。");
    }

    return record;
  }

  private save(record: LocalOverlayRecord) {
    return this.manifests.run(record.id, () => this.saveManifest(record));
  }

  private async saveManifest(record: LocalOverlayRecord) {
    const temporary = path.join(this.root, `${record.id}-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(recordSchema.parse(record)) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, this.file(record.id));
  }

  private async lock(id: string) {
    await mkdir(this.root, { recursive: true });
    const file = path.join(this.root, `${id}.lock`);
    const handle = await open(file, "wx", 0o600).catch(() => {
      throw new Error(
        "Local overlay 已被占用或上次操作结果未知；不会抢占或重放。",
      );
    });
    await handle.close();

    return () => unlink(file);
  }

  private async observe<T>(
    id: string,
    action: string,
    operation: () => Promise<T>,
    taskId?: string,
  ) {
    const operationId = randomUUID();
    this.traces.startTask(operationId, id);
    const span = this.traces.startSpan(operationId, {
      name: `local_overlay.${action}`,
      category: "worktree",
      track: "Local overlay lifecycle",
      attributes: { overlayId: id, ...(taskId ? { taskId } : {}) },
    });
    const started = performance.now();
    let outcome: "ok" | "unknown" = "unknown";
    this.log.info({
      module: "local-overlay",
      event: `${action}.started`,
      overlayId: id,
      taskId,
      operationId,
    });
    try {
      const result = await operation();
      outcome = "ok";

      return result;
    } finally {
      this.traces.endSpan(span, outcome);
      this.traces.finishTask(operationId, outcome);
      await this.archive
        .write(id, operationId, this.traces.exportTask(operationId))
        .catch((err) => {
          this.log.warn({
            module: "local-overlay",
            event: "trace.failed",
            err,
          });
        });
      this.traces.discardTask(operationId);
      this.log.info({
        module: "local-overlay",
        event: `${action}.finished`,
        overlayId: id,
        taskId,
        operationId,
        outcome,
        durationMs: performance.now() - started,
      });
    }
  }

  async validate(workspace: string, sessionId?: string) {
    const id = this.backend.idFor(workspace);
    if (!id) {
      return undefined;
    }

    const record = await this.read(id);
    await lstat(path.join(this.root, `${id}.refresh.lock`)).then(
      () => {
        throw new Error("Local overlay 刷新仍在进行或结果未知。");
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      },
    );
    if (
      (record.phase !== "ready" &&
        !(record.phase === "active" && this.active.has(id))) ||
      !record.controlIdentity ||
      !record.workspaceIdentity ||
      (sessionId && record.sessionId !== sessionId) ||
      (await directoryIdentity(record.source)) !== record.sourceIdentity ||
      (await directoryIdentity(this.control(id))) !== record.controlIdentity
    ) {
      throw new Error(
        "Local overlay 状态或目录身份改变；保留现场，不会自动恢复。",
      );
    }

    return record;
  }

  async projectWorkspace(workspace: string) {
    return (await this.validate(workspace))?.source;
  }

  /** Called only between native account termination and grant revocation, before serving tasks. */
  withSandboxRecoveryRoots(
    roots: readonly string[],
    signal: AbortSignal,
    revoke: () => Promise<void>,
  ) {
    const current = AbortSignal.any([signal, this.creation.signal]);
    const ids = [
      ...new Set(
        roots
          .map((root) => this.backend.idFor(root))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    const visit = async (index: number): Promise<void> => {
      current.throwIfAborted();
      const id = ids[index];
      if (!id) {
        await revoke();

        return;
      }

      await this.observe(id, "recover_access", async () => {
        const record = await this.read(id);
        if (
          this.active.has(id) ||
          !["active", "failed"].includes(record.phase) ||
          !record.sessionId ||
          !record.controlIdentity ||
          !record.workspaceIdentity ||
          (await directoryIdentity(record.source)) !== record.sourceIdentity ||
          (await directoryIdentity(this.control(id))) !== record.controlIdentity
        ) {
          throw new Error("Local overlay ACL 恢复身份或状态不匹配。");
        }

        // The root-only mount rechecks this proof under its exclusive native lease.
        // It exposes no file I/O and preserves dirty state; normal restore stays unchanged.
        await withLocalInspection(this.control(id), current, async () => {});
        if (JSON.stringify(await this.read(id)) !== JSON.stringify(record)) {
          throw new Error("Local overlay ACL 恢复清单已变化。");
        }

        if (!this.backend.recoverAccess) {
          throw new Error("Local overlay 缺少专用 ACL 恢复后端。");
        }

        const mount = await this.backend.recoverAccess(
          id,
          record.source,
          this.control(id),
          current,
        );
        try {
          if ((await mount.identity()) !== record.workspaceIdentity) {
            throw new Error("Local overlay ACL 恢复卷身份不匹配。");
          }

          await visit(index + 1);
        } finally {
          await mount.close();
        }
      });
    };

    const work = visit(0);
    this.creating.add(work);
    void work.finally(() => this.creating.delete(work)).catch(() => {});

    return work;
  }

  recoverPrivateRefresh(
    workspace: string,
    sessionId: string,
    signal: AbortSignal,
  ) {
    const work = this.recoverPrivateRefreshSerial(
      workspace,
      sessionId,
      AbortSignal.any([signal, this.creation.signal]),
    );
    this.creating.add(work);
    void work.finally(() => this.creating.delete(work)).catch(() => {});

    return work;
  }

  private async recoverPrivateRefreshSerial(
    workspace: string,
    sessionId: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const id = this.backend.idFor(workspace);
    if (!id || this.active.has(id)) {
      throw new Error("私有刷新需要非活动 Local 视图。");
    }

    return this.observe(id, "recover_private_refresh", async () => {
      const record = await this.read(id);
      if (
        record.sessionId !== sessionId ||
        record.phase !== "failed" ||
        !record.refreshRecovery ||
        record.refreshRecovery.taskId !== record.taskId ||
        record.refreshRecovery.batchId !== record.publication?.batchId ||
        !record.controlIdentity ||
        !record.workspaceIdentity ||
        (await directoryIdentity(record.source)) !== record.sourceIdentity ||
        (await directoryIdentity(this.control(id))) !== record.controlIdentity
      ) {
        throw new Error("缺少匹配的排空、批次或目录证明，不能恢复私有刷新。");
      }

      const guard = path.join(this.root, `${id}.refresh.lock`);
      const handle = await open(guard, "wx", 0o600);
      await handle.close();
      let mount: LocalOverlayMount | undefined;
      let releaseGuard = true;
      this.active.add(id);
      try {
        const lock = path.join(this.root, `${id}.lock`);
        const held = await lstat(lock);
        if (
          !held.isFile() ||
          held.isSymbolicLink() ||
          held.nlink !== 1 ||
          held.size !== 0 ||
          JSON.stringify(await this.read(id)) !== JSON.stringify(record)
        ) {
          throw new Error("原任务锁或清单改变。");
        }

        const publisher = new Publisher(
          path.join(this.root, "publications"),
          this.log,
        );
        const { journal } = await publisher.recordedJournal(
          await sourceIdentity(record.source),
          record.refreshRecovery.batchId,
        );
        const selected = new Set(
          record.publication!.paths.map((file) => file.toLowerCase()),
        );
        if (
          journal.state !== "complete" ||
          !journal.refresh ||
          journal.batch.changes.some(
            (file) => !selected.has(file.path.toLowerCase()),
          )
        ) {
          throw new Error("来源发布尚未完成或日志不属于本次选择。");
        }

        signal.throwIfAborted();
        // From here an unconfirmed mount/close keeps the recovery guard. The
        // original task lock remains until both refresh and shutdown are proven.
        releaseGuard = false;
        mount = await this.backend.open(
          id,
          record.source,
          this.control(id),
          false,
          signal,
        );
        if (
          !mount.recoverRefresh ||
          (await mount.identity()) !== record.workspaceIdentity
        ) {
          throw new Error("私有卷身份或刷新能力无法确认。");
        }

        const result = await mount.recoverRefresh(journal.batch, signal);
        await mount.close();
        mount = undefined;
        releaseGuard = true;
        signal.throwIfAborted();
        const current = await lstat(lock);
        if (
          current.dev !== held.dev ||
          current.ino !== held.ino ||
          current.size !== 0 ||
          JSON.stringify(await this.read(id)) !== JSON.stringify(record)
        ) {
          throw new Error("刷新收尾时原任务锁或清单改变。");
        }

        // Never leave a reusable view if deleting the old lock or persisting its
        // final state is unknown. A retained recovery guard also gates admission.
        releaseGuard = false;
        await unlink(lock);
        record.phase = "ready";
        record.epoch = result.epoch;
        record.outcome = "completed";
        record.publication = {
          ...record.publication!,
          state: "published",
          files: journal.entries.length,
          cleanupPending: journal.entries.filter(
            (entry) => entry.backup && !entry.backup.cleaned,
          ).length,
        };
        record.refreshRecovery = undefined;
        record.refreshedTaskId = record.taskId;
        await this.save(record);
        releaseGuard = true;

        return { recovered: true as const };
      } finally {
        try {
          if (mount) {
            await mount.close();
            releaseGuard = true;
          }
        } finally {
          this.active.delete(id);
          if (releaseGuard) {
            await unlink(guard);
          }
        }
      }
    });
  }

  publicationRecovery(
    workspace: string,
    sessionId: string,
    token?: string | { action: "release-complete" },
    signal = new AbortController().signal,
  ) {
    const work = this.recoverPublication(
      workspace,
      sessionId,
      token,
      AbortSignal.any([signal, this.creation.signal]),
    );
    this.creating.add(work);
    void work.finally(() => this.creating.delete(work)).catch(() => {});

    return work;
  }

  private async recoverPublication(
    workspace: string,
    sessionId: string,
    token: string | { action: "release-complete" } | undefined,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const id = this.backend.idFor(workspace);
    if (!id || this.active.has(id)) {
      throw new Error("发布现场仍有活动任务或不是 Local 视图。");
    }

    return this.observe(
      id,
      token === undefined
        ? "publication_review"
        : typeof token === "string"
          ? "publication_accept"
          : "publication_release_complete",
      async () => {
        const record = await this.read(id);
        if (
          record.sessionId !== sessionId ||
          !["failed", "active"].includes(record.phase) ||
          !record.publication?.batchId ||
          !record.controlIdentity ||
          (await directoryIdentity(record.source)) !== record.sourceIdentity ||
          (await directoryIdentity(this.control(id))) !== record.controlIdentity
        ) {
          throw new Error("发布恢复的会话、来源或私有目录身份无法确认。");
        }

        const publisher = new Publisher(
          path.join(this.root, "publications"),
          this.log,
        );
        const { journal } = await publisher.recordedJournal(
          await sourceIdentity(record.source),
          record.publication.batchId,
        );
        const selected = new Set(
          record.publication.paths.map((file) => file.toLowerCase()),
        );
        if (
          journal.batch.changes.some(
            (file) => !selected.has(file.path.toLowerCase()),
          )
        ) {
          throw new Error("发布日志超出此会话记录的选择。");
        }

        signal.throwIfAborted();
        if (
          this.active.has(id) ||
          JSON.stringify(await this.read(id)) !== JSON.stringify(record)
        ) {
          throw new Error("发布恢复期间会话状态改变。");
        }

        if (typeof token === "object") {
          // This proof belongs only to the source publisher. It says nothing
          // about private Runtime descendants; never remove the view lock here.
          if (journal.state !== "complete") {
            throw new Error("发布尚未完整完成，不能释放完成态来源锁。");
          }

          const result = await publisher.releaseCompletedLock(
            journal.batch,
            signal,
          );

          return { kind: "complete-lock" as const, released: result.released };
        }

        if (typeof token === "string") {
          return publisher.acceptUnknown(journal.batch, token, signal);
        }

        if (journal.state === "complete") {
          return {
            kind: "complete" as const,
            refresh: journal.refresh?.state ?? "unrecorded",
          };
        }

        if (journal.state === "reconciled") {
          return {
            kind: "decision" as const,
            token: journal.resolution!.token,
          };
        }

        // A private-view lock cannot establish process quiescence. Keep it and
        // the manifest untouched; the source execution lease independently proves
        // that the old publisher is gone before returning reviewable contents.
        return publisher.reviewUnknown(journal.batch, signal, 16 * 1024 * 1024);
      },
    );
  }

  review(
    workspace: string,
    sessionId: string,
    relative: string,
    signal: AbortSignal,
  ) {
    return this.inspect(
      workspace,
      sessionId,
      (source, control, currentSignal) =>
        reviewCleanFile(source, control, relative, currentSignal),
      signal,
    );
  }

  reviewBatch(
    workspace: string,
    sessionId: string,
    paths: readonly string[],
    signal: AbortSignal,
  ) {
    return this.inspect(
      workspace,
      sessionId,
      (source, control, currentSignal) =>
        reviewCleanFiles(source, control, paths, currentSignal),
      signal,
    );
  }

  reviewInterrupted(
    workspace: string,
    sessionId: string,
    paths: readonly string[],
    signal: AbortSignal,
  ) {
    const work = this.inspectInterrupted(
      workspace,
      sessionId,
      reviewSelection(paths),
      AbortSignal.any([signal, this.creation.signal]),
    );
    this.creating.add(work);
    void work.finally(() => this.creating.delete(work)).catch(() => {});

    return work;
  }

  private async inspectInterrupted(
    workspace: string,
    sessionId: string,
    paths: readonly string[],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const id = this.backend.idFor(workspace);
    if (!id || this.active.has(id)) {
      throw new Error("中断检查不能读取活动任务或普通工作目录。");
    }

    return this.observe(id, "interrupted_review", async () => {
      const record = await this.read(id);
      const source = await sourceIdentity(record.source);
      const control = await sourceIdentity(this.control(id));
      if (
        record.sessionId !== sessionId ||
        !["failed", "active"].includes(record.phase) ||
        (await directoryIdentity(record.source)) !== record.sourceIdentity ||
        (await directoryIdentity(this.control(id))) !== record.controlIdentity
      ) {
        throw new Error("中断检查的会话、来源或私有目录身份无法确认。");
      }

      // The stale service lock is evidence, not a lease we may steal. Native
      // inspection holds mount.lock and proves the old execution identities gone.
      const result = await inspectInterruptedFiles(source, control, paths, {
        signal,
        log: this.log,
        traceDirectory: path.join(this.root, "inspections"),
      });
      signal.throwIfAborted();
      if (
        this.active.has(id) ||
        JSON.stringify(await this.read(id)) !== JSON.stringify(record) ||
        (await directoryIdentity(record.source)) !== record.sourceIdentity ||
        (await directoryIdentity(this.control(id))) !== record.controlIdentity
      ) {
        throw new Error("中断检查期间会话或目录身份改变。");
      }

      return result;
    });
  }

  private inspect<T>(
    workspace: string,
    sessionId: string,
    read: (source: Source, control: string, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    const work = this.reviewSerial(
      workspace,
      sessionId,
      read,
      AbortSignal.any([signal, this.creation.signal]),
    );
    this.creating.add(work);
    void work.finally(() => this.creating.delete(work)).catch(() => {});

    return work;
  }

  private async reviewSerial<T>(
    workspace: string,
    sessionId: string,
    read: (source: Source, control: string, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const initial = await this.validate(workspace, sessionId);
    if (!initial || initial.phase !== "ready") {
      throw new Error("只可检查已正常结束的 Local overlay 私有修改。");
    }

    const release = await this.lock(initial.id);
    try {
      return await this.observe(initial.id, "review", async () => {
        const record = await this.validate(workspace, sessionId);
        if (!record || record.phase !== "ready") {
          throw new Error("Local overlay 检查期间状态改变。");
        }

        const result = await read(
          await sourceIdentity(record.source),
          this.control(record.id),
          signal,
        );
        await this.validate(workspace, sessionId);
        signal.throwIfAborted();

        return result;
      });
    } finally {
      // This operation never mounts or writes the view/source. A failed read is
      // not an unknown publication and must not quarantine a healthy view.
      await release();
    }
  }

  /** 历史读取只投影公开状态，不挂载或修复；损坏/丢失清单仍标为托管视图。 */
  async describe(session: Session): Promise<Session> {
    const id = this.backend.idFor(session.workspace);
    if (!id) {
      return session;
    }

    try {
      const record = await this.read(id);
      if (record.sessionId !== session.id) {
        throw new Error("Local overlay 会话身份不匹配。");
      }

      return {
        ...session,
        localOverlay: {
          id,
          projectWorkspace: record.source,
          state: record.phase,
          epoch: record.epoch,
          ...(record.phase === "ready" &&
          record.publication?.state === "published" &&
          record.refreshedTaskId &&
          record.refreshedTaskId === record.taskId
            ? { refreshedTaskId: record.refreshedTaskId }
            : {}),
          ...(record.phase === "failed" && record.refreshRecovery
            ? { privateRefreshRecovery: true }
            : {}),
          ...(["failed", "active"].includes(record.phase) &&
          !this.active.has(id)
            ? { interruptedReview: true }
            : {}),
          ...(record.publication?.batchId &&
          (record.phase === "failed" ||
            (record.phase === "active" && !this.active.has(id)))
            ? { publicationRecovery: true }
            : {}),
          resolution: record.resolution && {
            sessionId: record.resolution.sessionId,
            path: resolutionPaths(record.resolution)[0]!,
            ...("paths" in record.resolution
              ? { paths: record.resolution.paths }
              : {}),
            directory: resolutionDirectory(record.id),
            ...("state" in record.resolution
              ? { state: record.resolution.state }
              : {}),
          },
          publication: record.publication && {
            state: record.publication.state,
            files: record.publication.files,
            reason: record.publication.reason,
          },
        },
      };
    } catch {
      return { ...session, localOverlay: { id, state: "unavailable" } };
    }
  }

  /** Internal trusted selection boundary, not an arbitrary callback from HTTP or model input. */
  async select(
    workspace: string,
    sessionId: string,
    taskId: string,
    input: PublicationSelection | null,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const selected = input === null ? undefined : publicationSelection(input);
    const record = await this.validate(workspace, sessionId);
    const binding = record && this.tasks.get(record.id);
    if (
      !record ||
      record.phase !== "active" ||
      !binding ||
      binding.taskId !== taskId ||
      binding.finishing
    ) {
      throw new Error("发布选择只能绑定当前活动 Local overlay 任务。");
    }

    // No filesystem or source mutation before the task's drained finish. The
    // selection itself is saved with that finish, avoiding races with parallel tools.
    return this.observe(
      record.id,
      "select",
      async () => {
        signal?.throwIfAborted();
        binding.selection = selected;

        return {
          selected: selected?.paths.length ?? 0,
          published: false as const,
        };
      },
      taskId,
    );
  }

  /** bind 必须按固定 workspace 幂等查找/建立会话，覆盖 Store 已保存而清单回执丢失的窗口。 */
  create(
    input: { id: string; source: string },
    bind: (workspace: string, sessionId?: string) => Promise<Session>,
  ) {
    const work = this.createSerial(input, bind);
    this.creating.add(work);
    void work.finally(() => this.creating.delete(work)).catch(() => {});

    return work;
  }

  continueResolution(
    input: ResolutionRequest,
    bind: (workspace: string, sessionId?: string) => Promise<Session>,
  ) {
    const work = this.continueResolutionSerial(input, bind);
    this.creating.add(work);
    void work.finally(() => this.creating.delete(work)).catch(() => {});

    return work;
  }

  private async continueResolutionSerial(
    input: ResolutionRequest,
    bind: (workspace: string, sessionId?: string) => Promise<Session>,
  ) {
    const parentId = this.backend.idFor(input.workspace);
    if (!parentId || parentId === input.id) {
      throw new Error("冲突继续需要新的 Local 视图标识。");
    }

    if (!("paths" in input)) {
      checkRelative(input.path);
    }

    const origin = resolutionOriginSchema.parse({
      overlayId: parentId,
      sessionId: input.sessionId,
      ...("paths" in input
        ? {
            paths: reviewSelection(input.paths),
            ...(input.state ? { state: input.state } : {}),
          }
        : { path: input.path }),
      version: input.version,
    });
    const parent = await this.read(parentId);
    if (parent.sessionId !== input.sessionId) {
      throw new Error("冲突继续的原会话身份不匹配。");
    }

    return this.createSerial({ id: input.id, source: parent.source }, bind, {
      origin,
      prepare: async () => {
        const review =
          "paths" in input
            ? input.state === "interrupted"
              ? await this.reviewInterrupted(
                  input.workspace,
                  input.sessionId,
                  input.paths,
                  this.creation.signal,
                )
              : await this.reviewBatch(
                  input.workspace,
                  input.sessionId,
                  input.paths,
                  this.creation.signal,
                )
            : await this.review(
                input.workspace,
                input.sessionId,
                input.path,
                this.creation.signal,
              );
        if (review.version !== input.version) {
          throw new Error("检查材料已经改变，请重新检查后继续。");
        }

        return review;
      },
    });
  }

  private async createSerial(
    input: { id: string; source: string },
    bind: (workspace: string, sessionId?: string) => Promise<Session>,
    resolution?: {
      origin: ResolutionOrigin;
      prepare: () => Promise<
        LocalFileReview | LocalReviewBatch | InterruptedReview
      >;
    },
  ) {
    const id = z.uuid().parse(input.id);
    this.creation.signal.throwIfAborted();
    const source = await realpath(input.source);
    const sourceIdentity = await directoryIdentity(source);
    await mkdir(this.root, { recursive: true });
    const privateRoot = await realpath(this.directory);
    if (
      inside(source, privateRoot) ||
      inside(privateRoot, source) ||
      this.backend.idFor(source)
    ) {
      throw new Error("Local overlay 来源不能与宿主私有数据或托管视图重叠。");
    }

    const release = await this.lock(id);

    return this.observe(id, "create", async () => {
      // Pure admission failures must not quarantine an existing healthy view.
      // Once preparation starts, uncertain side effects retain this lease.
      let releaseAllowed = true;
      let mount: LocalOverlayMount | undefined;
      let record: LocalOverlayRecord | undefined;
      try {
        record = await this.read(id).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }

          return undefined;
        });
        if (record) {
          if (
            record.phase !== "ready" ||
            record.source !== source ||
            record.sourceIdentity !== sourceIdentity ||
            JSON.stringify(record.resolution) !==
              JSON.stringify(resolution?.origin)
          ) {
            throw new Error("Local overlay 创建请求已绑定其它状态或来源。");
          }

          await this.validate(this.backend.workspace(id));
          releaseAllowed = true;
        } else {
          // Review before allocating the new view. Already-complete retries
          // above never read later parent edits or seed another private copy.
          const reference = await resolution?.prepare();
          releaseAllowed = false;
          record = {
            version: 1,
            format: 6,
            id,
            source,
            sourceIdentity,
            phase: "preparing",
            resolution: resolution?.origin,
          };
          await this.save(record);
          mount = await this.backend.open(
            id,
            source,
            this.control(id),
            true,
            this.creation.signal,
          );
          record.controlIdentity = await directoryIdentity(this.control(id));
          record.workspaceIdentity = await mount.identity();
          if (reference && resolution) {
            await seedResolution(
              this.backend.workspace(id),
              id,
              resolution.origin,
              reference,
              this.creation.signal,
            );
          }

          await mount.close();
          mount = undefined;
          record.phase = "ready";
          await this.save(record);
          releaseAllowed = true;
        }

        this.creation.signal.throwIfAborted();
        const session = await bind(
          this.backend.workspace(id),
          record.sessionId,
        );
        if (
          session.workspace !== this.backend.workspace(id) ||
          (record.sessionId && session.id !== record.sessionId)
        ) {
          throw new Error("Local overlay 会话绑定改变。");
        }

        record.sessionId = session.id;
        await this.save(record);

        return session;
      } catch (error) {
        if (!releaseAllowed && record) {
          record.phase = "failed";
          await this.save(record).catch(() => {});
        }

        await mount?.close().catch(() => {});
        throw error;
      } finally {
        if (releaseAllowed) {
          await release();
        }
      }
    });
  }

  async begin(
    workspace: string,
    sessionId: string,
    taskId: string,
    signal: AbortSignal,
  ): Promise<LocalOverlayLease | undefined> {
    const initial = await this.validate(workspace, sessionId);
    if (!initial) {
      return undefined;
    }

    z.uuid().parse(taskId);
    signal.throwIfAborted();
    const release = await this.lock(initial.id);

    return this.observe(
      initial.id,
      "begin",
      async () => {
        let record: LocalOverlayRecord;
        try {
          const checked = await this.validate(workspace, sessionId);
          if (!checked || checked.phase !== "ready") {
            throw new Error("Local overlay 上次任务未确认结束。");
          }

          signal.throwIfAborted();
          record = checked;
        } catch (error) {
          await release();
          throw error;
        }

        record.phase = "active";
        record.taskId = taskId;
        record.publication = undefined;
        record.refreshRecovery = undefined;
        record.refreshedTaskId = undefined;
        await this.save(record);
        let mount: LocalOverlayMount | undefined;
        try {
          mount = await this.backend.open(
            record.id,
            record.source,
            this.control(record.id),
            false,
            signal,
          );
          if ((await mount.identity()) !== record.workspaceIdentity) {
            throw new Error("Local overlay 卷身份改变。");
          }
        } catch (error) {
          record.phase = "failed";
          await this.save(record).catch(() => {});
          await mount?.close().catch(() => {});
          throw error;
        }

        this.active.add(record.id);
        const binding: {
          taskId: string;
          finishing: boolean;
          selection?: PublicationSelection;
        } = { taskId, finishing: false };
        this.tasks.set(record.id, binding);
        let finished: Promise<LocalOverlayRecord> | undefined;
        const current = mount;

        return {
          finish: (status, drained) => {
            binding.finishing = true;
            finished ??= this.observe(
              record.id,
              "finish",
              async () => {
                try {
                  if (
                    !drained ||
                    ![
                      "completed",
                      "failed",
                      "cancelled",
                      "interrupted",
                    ].includes(status)
                  ) {
                    throw new Error(
                      "Local overlay 任务排空未确认，私有现场已隔离。",
                    );
                  }

                  if (binding.selection) {
                    record.publication = {
                      state: status === "completed" ? "selected" : "retained",
                      paths: [...binding.selection.paths],
                    };
                    await this.save(record);
                  }

                  const result = await current.finish(
                    taskId,
                    status === "completed" && binding.selection
                      ? {
                          ...binding.selection,
                          signal,
                          record: async (state) => {
                            record.publication = state;
                            await this.save(record);
                          },
                        }
                      : undefined,
                  );
                  record.phase = "ready";
                  record.outcome =
                    result.publication?.state === "rejected"
                      ? "failed"
                      : (status as LocalOverlayRecord["outcome"]);
                  record.epoch = result.epoch;
                  record.capturedPaths = result.capturedPaths;
                  await this.save(record);
                  await release();

                  return record;
                } catch (error) {
                  record.phase = "failed";
                  await this.save(record).catch(() => {});
                  try {
                    await current.close();
                    if (
                      drained &&
                      error instanceof PublishError &&
                      error.code === "VIEW_REFRESH_PENDING" &&
                      record.publication?.batchId
                    ) {
                      record.refreshRecovery = {
                        taskId,
                        batchId: record.publication.batchId,
                      };
                      await this.save(record);
                    }
                  } catch {
                    // No durable proof is added if close or its record is unknown.
                  }

                  throw error;
                } finally {
                  this.active.delete(record.id);
                  this.tasks.delete(record.id);
                }
              },
              taskId,
            );

            return finished;
          },
        };
      },
      taskId,
    );
  }

  async cancelCreation() {
    this.creation.abort(new Error("服务正在关闭。"));
    await Promise.allSettled([...this.creating]);
  }

  async close() {
    await this.cancelCreation();
    if (this.active.size) {
      throw new Error("Local overlay 活动任务尚未排空。");
    }
  }
}
