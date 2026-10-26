/**
 * 为 Local 发布创建一次性候选工程，供可信 Engine 验证适配器和手动 Sandbox 验证调用。
 * 1. CandidateExecutor 接收隔离工作目录和取消信号，必须报告真实模式、退出码与已确认的进程树排空。
 * 2. validate 校验并复制有界候选输入，建立全新 Local lower/upper，只播种合并结果，不读取原会话 upper。
 * 3. 执行完成后冻结，核对候选未被测试改写并提取新读依赖；返回给 Publisher 作应用前复核。
 * 4. 正常卸载后删除本次 UUID 控制目录；排空未知保留现场并抛特殊错误，禁止重放或当作普通失败续聊。
 * 5. trace/log 只记录验证 ID、阶段、耗时与终态；命令、路径、候选内容不进入属性。
 * 执行器是可信内部接口，不能由模型反序列化；本模块不创建权限、宿主 fallback 或 Git 工作区。
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../worktrees/overlay.js";
import { canonical, inside } from "../tools/paths.js";
import { checkRelative, sourceIdentity } from "./publication/files.js";
import { MAX_BYTES, PublishError } from "./publication/merge.js";
import {
  candidateReads,
  CandidateCleanupUnknownError,
  type ValidationReceipt,
} from "./candidate-reads.js";

export type CandidateExecutor = (
  workspace: string,
  signal: AbortSignal,
) => Promise<{
  drained: boolean;
  sandboxApplied: boolean;
  exitCode: number | null;
}>;

export class CandidateValidator {
  private readonly traces = new TraceRecorder();

  constructor(
    private readonly directory: string,
    private readonly log: Logger,
  ) {}

  async validate(
    sourceDirectory: string,
    input: ReadonlyMap<string, Buffer | null>,
    execute: CandidateExecutor,
    signal: AbortSignal,
    sandboxRequired = true,
  ): Promise<ValidationReceipt> {
    signal.throwIfAborted();
    if (process.platform !== "win32") {
      throw new PublishError("WINDOWS_REQUIRED");
    }

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
    const storagePath = await canonical(this.directory);
    if (inside(source.root, storagePath) || inside(storagePath, source.root)) {
      throw new PublishError("CONTROL_OVERLAP");
    }

    await mkdir(storagePath, { recursive: true });
    const storage = await sourceIdentity(storagePath);
    if (
      inside(source.root, storage.root) ||
      inside(storage.root, source.root)
    ) {
      throw new PublishError("CONTROL_OVERLAP");
    }

    const id = randomUUID();
    const control = path.join(storage.root, id);
    const workspace = overlayWorkspace(overlayNamespace(storage.root), id);
    const manager = new OverlayManager(storage.root, this.log);
    this.traces.startTask(id, id);
    const span = this.traces.startSpan(id, {
      name: "local_overlay.candidate",
      category: "workspace",
      track: "Local candidate validation",
      attributes: { validationId: id, files: candidates.size },
    });
    const started = performance.now();
    let outcome: "ok" | "error" | "cancelled" | "unknown" = "error";
    let executionUnknown = false;
    let controlIdentity: string | undefined;
    this.log.info({
      module: "local-publication",
      event: "candidate.started",
      validationId: id,
    });
    try {
      await manager.start(id, source.root, control, workspace, true, signal, {
        kind: "local",
      });
      controlIdentity = (await sourceIdentity(control)).identity;
      for (const [file, content] of candidates) {
        signal.throwIfAborted();
        if (content === null) {
          await unlink(path.join(workspace, file));
        } else {
          await writeFile(path.join(workspace, file), content);
        }
      }

      // A thrown executor cannot prove its children stopped. Adapters must wait
      // for cleanup and resolve nonzero/null for ordinary command failures.
      executionUnknown = true;
      const result = await execute(workspace, signal);
      if (result.drained !== true) {
        throw new CandidateCleanupUnknownError();
      }

      executionUnknown = false;
      signal.throwIfAborted();
      if (
        (sandboxRequired && result.sandboxApplied !== true) ||
        result.exitCode !== 0
      ) {
        throw new PublishError("CANDIDATE_VALIDATION_FAILED");
      }

      const receipt = await manager.withFrozen(
        id,
        async (verify, _acknowledge, frozenSignal) => {
          frozenSignal.throwIfAborted();
          signal.throwIfAborted();

          return candidateReads(
            source,
            control,
            candidates,
            verify,
            AbortSignal.any([signal, frozenSignal]),
          );
        },
      );
      outcome = "ok";

      return receipt;
    } catch (error) {
      outcome = executionUnknown
        ? "unknown"
        : signal.aborted
          ? "cancelled"
          : "error";
      if (executionUnknown) {
        throw new CandidateCleanupUnknownError(error);
      }

      throw error;
    } finally {
      try {
        await manager.close();
        if (!executionUnknown && controlIdentity) {
          // Delete only our confirmed, unmounted UUID child, never source or a
          // replaced/junction control root. Unknown execution keeps its evidence.
          const current = await sourceIdentity(control);
          if (
            current.root !== control ||
            current.identity !== controlIdentity ||
            !inside(storage.root, current.root) ||
            current.root === storage.root
          ) {
            throw new Error("Candidate control identity changed");
          }

          await rm(control, { recursive: true });
        }
      } catch (error) {
        outcome = "unknown";
        throw new CandidateCleanupUnknownError(error);
      } finally {
        this.traces.endSpan(span, outcome);
        this.traces.finishTask(id, outcome);
        await new TraceArchive(storage.root, this.log)
          .write(id, id, this.traces.exportTask(id))
          .catch(() => {});
        this.traces.discardTask(id);
        this.log.info({
          module: "local-publication",
          event: "candidate.finished",
          validationId: id,
          outcome,
          durationMs: performance.now() - started,
        });
      }
    }
  }
}
