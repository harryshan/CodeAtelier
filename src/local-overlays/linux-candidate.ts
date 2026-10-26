/**
 * Linux 发布候选的实际挂载/验证适配器，供 backend 与 Engine 的可信执行器使用。
 * 1. 有界复制明确候选内容，控制器建立全新 lower/upper，仅播种所选文件，不继承任务产物。
 * 2. 执行器必须返回真实 Sandbox、退出码和排空证明；抛错或未知排空保持候选挂载与证据。
 * 3. 正常排空后核对候选内容，seal 导出新增读依赖，再普通卸载并删除本次身份匹配的私有目录。
 * 4. 控制 IPC/命令使用既有 tracing；本适配器另记录候选整体生命周期，不记录文件路径或正文。
 * 不执行 Git、不扩大来源权限；只支持普通文件及已存在父目录，未知结果不转宿主执行。
 */
import { randomUUID } from "node:crypto";
import { rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";
import type { CandidateExecutor } from "./candidate-validator.js";
import {
  CandidateCleanupUnknownError,
  validateReceipt,
  type ValidationReceipt,
} from "./candidate-reads.js";
import {
  checkRelative,
  checkedPath,
  snapshot,
  sourceIdentity,
} from "./publication/files.js";
import { MAX_BYTES, PublishError } from "./publication/merge.js";
import { posixReads, readPosixManifest } from "./posix-batch.js";
import type { LinuxMountController } from "./linux-backend.js";

export class LinuxCandidateValidator {
  constructor(
    private readonly root: string,
    private readonly controller: LinuxMountController,
    private readonly log: Logger,
    private readonly views?: string,
  ) {}

  async validate(
    sourceDirectory: string,
    input: ReadonlyMap<string, Buffer | null>,
    execute: CandidateExecutor,
    signal: AbortSignal,
  ): Promise<ValidationReceipt> {
    signal.throwIfAborted();
    const candidates = new Map<string, Buffer | null>();
    const keys = new Set<string>();
    let total = 0;
    for (const [file, content] of input) {
      checkRelative(file);
      if (
        keys.has(file.toLowerCase()) ||
        (content !== null &&
          (!Buffer.isBuffer(content) || content.length > MAX_BYTES))
      ) {
        throw new PublishError("CANDIDATE_INVALID");
      }

      keys.add(file.toLowerCase());
      candidates.set(file, content === null ? null : Buffer.from(content));
      total += content?.length ?? 0;
    }

    if (!candidates.size || candidates.size > 100 || total > 16 * 1024 * 1024) {
      throw new PublishError("BATCH_LIMIT");
    }

    const source = await sourceIdentity(sourceDirectory);
    const id = randomUUID();
    const storage = path.join(this.root, id);
    const traces = new TraceRecorder();
    traces.startTask(id, id);
    const span = traces.startSpan(id, {
      name: "local_overlay.linux.candidate",
      category: "workspace",
      track: "Linux candidate",
      attributes: { files: candidates.size },
    });
    let mounted = false;
    let mountUnknown = false;
    let executionUnknown = false;
    let storageIdentity: string | undefined;
    let backingIdentity: string | undefined;
    const workspacePath = this.views
      ? path.join(this.views, id)
      : path.join(storage, "view");
    let outcome: "ok" | "error" | "unknown" = "error";
    const started = performance.now();
    this.log.info({
      module: "linux-overlay",
      event: "candidate.started",
      validationId: id,
    });
    try {
      mountUnknown = true;
      const view = await this.controller.open(id, source.root, true);
      mounted = true;
      if (
        view.workspace !== workspacePath ||
        path.dirname(view.control) !== storage
      ) {
        throw new CandidateCleanupUnknownError();
      }

      storageIdentity = (await sourceIdentity(storage)).identity;
      backingIdentity = view.backingIdentity;
      mountUnknown = false;
      const workspace = await sourceIdentity(view.workspace);
      for (const [file, content] of candidates) {
        signal.throwIfAborted();
        const target = await checkedPath(workspace, file);
        if (content === null) {
          await unlink(target);
        } else {
          await writeFile(target, content);
        }
      }

      executionUnknown = true;
      const result = await execute(view.workspace, signal);
      if (!result.drained) {
        throw new CandidateCleanupUnknownError();
      }

      executionUnknown = false;
      signal.throwIfAborted();
      if (!result.sandboxApplied || result.exitCode !== 0) {
        throw new PublishError("CANDIDATE_VALIDATION_FAILED");
      }

      for (const [file, content] of candidates) {
        const current = await snapshot(workspace, file);
        if (current.content !== (content?.toString("base64") ?? null)) {
          throw new PublishError("CANDIDATE_CHANGED");
        }
      }

      const sealId = await this.controller.seal(id);
      const manifest = await readPosixManifest(view.control, sealId, source);
      const reads = await posixReads(
        source,
        view.control,
        manifest,
        new Set(candidates.keys()),
        signal,
      );
      const receipt = validateReceipt({ reads });
      outcome = "ok";

      return receipt;
    } catch (error) {
      if (
        mountUnknown ||
        executionUnknown ||
        error instanceof CandidateCleanupUnknownError
      ) {
        executionUnknown = true;
        outcome = "unknown";
        throw new CandidateCleanupUnknownError(error);
      }

      throw error;
    } finally {
      try {
        if (mounted && !executionUnknown) {
          await this.controller.close(id);
          if (this.views) {
            if (
              !backingIdentity ||
              (await sourceIdentity(workspacePath)).identity !== backingIdentity
            ) {
              throw new Error("Candidate mountpoint changed");
            }

            await rmdir(workspacePath);
          }

          if (
            !storageIdentity ||
            (await sourceIdentity(storage)).identity !== storageIdentity
          ) {
            throw new Error("Candidate storage changed");
          }

          await rm(storage, { recursive: true });
        }
      } catch (error) {
        outcome = "unknown";
        throw new CandidateCleanupUnknownError(error);
      } finally {
        traces.endSpan(span, outcome);
        traces.finishTask(id, outcome);
        await new TraceArchive(this.root, this.log).write(
          id,
          id,
          traces.exportTask(id),
        );
        traces.discardTask(id);
        this.log.info({
          module: "linux-overlay",
          event: "candidate.finished",
          validationId: id,
          outcome,
          durationMs: performance.now() - started,
        });
      }
    }
  }
}
