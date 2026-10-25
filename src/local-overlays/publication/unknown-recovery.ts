/**
 * 未知来源发布的明确现场接受协议，供 Publisher 的 reviewUnknown/acceptUnknown 调用。
 * 1. 必须有记录的原生 generation/协调锁摘要；检查 helper 持排他证明旧宿主及写入已停止。
 * 2. review 只读取 journal、锁与逐文件现场，返回绑定版本的 token 和可审核 B/O/T，不修改来源。
 * 3. accept 重新取排他并复核 token，先保存 reconciled 决定再释放同一协调锁；不重放或回滚文件。
 * 4. 重复已落盘决定可完成遗留解锁，旧 token 不能清除新的锁；私有修改、备份及 pending 确认均保留。
 * 5. trace 仅记录 batch ID、模式、耗时、结果，不含路径、正文、token 或文件版本。
 * 仅 Windows 原生执行租约可证明排空；旧日志拒绝，外部写者仍可能在最后复核后改变现场。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { TraceRecorder } from "../../tracing/recorder.js";
import type { TraceStatus } from "../../tracing/types.js";
import {
  digest,
  snapshot,
  sourceIdentity,
  durableJson,
  type Snapshot,
} from "./files.js";
import { loadJournal, saveJournal, type Journal } from "./journal.js";
import { PublicationLease } from "./publication-lease.js";
import { PublishError, equal } from "./merge.js";
import type { Batch } from "./session.js";

export interface UnknownReview {
  kind: "review";
  token: string;
  files: {
    path: string;
    recorded: string;
    observed: "before" | "after" | "diverged";
    before: Snapshot;
    proposed: string | null;
    current: Snapshot;
  }[];
}
export interface UnknownAccepted {
  kind: "accepted";
  alreadyAccepted: boolean;
}

async function lockVersion(directory: string) {
  const lock = await snapshot(await sourceIdentity(directory), "publish.lock");

  return lock.content === null
    ? null
    : digest(Buffer.from(lock.content, "base64"));
}

function execution(journal: Journal) {
  if (!journal.execution?.lockDigest) {
    throw new PublishError("RECOVERY_EXECUTION_PROOF_MISSING");
  }

  if (
    !["applying", "unknown", "aborted", "reconciled"].includes(journal.state)
  ) {
    throw new PublishError("RECOVERY_NOT_UNKNOWN");
  }

  return journal.execution;
}

async function observe(journal: Journal): Promise<UnknownReview["files"]> {
  const result: UnknownReview["files"] = [];
  for (const entry of journal.entries) {
    const current = await snapshot(journal.batch.source, entry.path);
    const decode = (value: string | null) =>
      value === null ? null : Buffer.from(value, "base64");
    const observed = equal(decode(current.content), decode(entry.after))
      ? "after"
      : current.version === entry.before.version
        ? "before"
        : "diverged";
    result.push({
      path: entry.path,
      recorded: entry.state,
      observed,
      before: entry.before,
      proposed: entry.after,
      current,
    });
  }

  return result;
}

export async function unknownRecovery(options: {
  batch: Batch;
  directory: string;
  log: Logger;
  token?: string;
  signal?: AbortSignal;
}): Promise<UnknownReview | UnknownAccepted> {
  const { batch, directory, log, token, signal } = options;
  const file = path.join(directory, batch.id, "journal.json");
  const task = randomUUID();
  const traces = new TraceRecorder();
  const mode = token === undefined ? "review" : "accept";
  traces.startTask(task, batch.id);
  const span = traces.startSpan(task, {
    name: `local_overlay.unknown_${mode}`,
    category: "workspace",
    track: "Unknown publication recovery",
    attributes: { batchId: batch.id },
  });
  const started = performance.now();
  let outcome: TraceStatus = "error";
  let lease: PublicationLease | undefined;
  let decisionWritten = false;
  let activeSignal = signal;
  log.info({
    module: "local-publication",
    event: "unknown_recovery_started",
    batchId: batch.id,
    operationId: task,
    mode,
  });
  try {
    signal?.throwIfAborted();
    const initial = await loadJournal(file, batch);
    const proof = execution(initial.journal);
    if (
      mode === "accept" &&
      initial.journal.state === "reconciled" &&
      initial.journal.resolution?.token === token &&
      (await lockVersion(directory)) !== proof.lockDigest
    ) {
      // A prior durable decision already released its lock. Never touch a new
      // owner's lock or require that unrelated later source edits stay frozen.
      outcome = "ok";

      return { kind: "accepted", alreadyAccepted: true };
    }

    lease = await PublicationLease.start(
      path.join(directory, "execution.lease"),
      proof.generation,
    );
    activeSignal = signal
      ? AbortSignal.any([signal, lease.signal])
      : lease.signal;
    const loaded = await loadJournal(file, batch);
    const journal = loaded.journal;
    if (
      execution(journal).generation !== proof.generation ||
      execution(journal).lockDigest !== proof.lockDigest ||
      (await lockVersion(directory)) !== proof.lockDigest
    ) {
      throw new PublishError("RECOVERY_LOCK_CHANGED");
    }

    activeSignal.throwIfAborted();
    const files = await observe(journal);
    activeSignal.throwIfAborted();
    const currentToken =
      journal.state === "reconciled"
        ? journal.resolution!.token
        : digest(
            JSON.stringify({
              journal: loaded.version,
              lock: proof.lockDigest,
              versions: files.map((entry) => entry.current.version),
            }),
          );
    if (mode === "review") {
      outcome = "ok";

      return { kind: "review", token: currentToken, files };
    }

    if (token !== currentToken) {
      throw new PublishError("RECOVERY_REVIEW_STALE");
    }

    activeSignal.throwIfAborted();
    const alreadyAccepted = journal.state === "reconciled";
    if (!alreadyAccepted) {
      // Persist what was explicitly accepted before releasing the source gate.
      // This is not a claim that every original candidate was published.
      journal.state = "reconciled";
      journal.resolution = {
        action: "accept-current",
        token,
        files: files.map((entry) => ({
          path: entry.path,
          version: entry.current.version,
        })),
      };
      await saveJournal(file, journal, loaded.version);
    }

    decisionWritten = true;
    activeSignal.throwIfAborted();
    if ((await lockVersion(directory)) !== proof.lockDigest) {
      throw new PublishError("RECOVERY_LOCK_CHANGED");
    }

    activeSignal.throwIfAborted();
    await lease.releaseLock(proof.lockDigest!);
    outcome = "ok";

    return { kind: "accepted", alreadyAccepted };
  } catch (error) {
    outcome = decisionWritten
      ? "unknown"
      : activeSignal?.aborted
        ? "cancelled"
        : "error";
    throw error;
  } finally {
    try {
      await lease?.close();
    } catch (error) {
      outcome = "unknown";
      throw error;
    } finally {
      traces.endSpan(span, outcome);
      traces.finishTask(task, outcome);
      try {
        await durableJson(
          path.join(directory, batch.id, `unknown-trace-${task}.json`),
          traces.exportTask(task),
        );
      } catch {
        log.warn({
          module: "local-publication",
          event: "unknown_trace_failed",
          batchId: batch.id,
          operationId: task,
        });
      }

      traces.discardTask(task);
      log.info({
        module: "local-publication",
        event: "unknown_recovery_finished",
        batchId: batch.id,
        operationId: task,
        mode,
        outcome,
        durationMs: performance.now() - started,
      });
    }
  }
}
