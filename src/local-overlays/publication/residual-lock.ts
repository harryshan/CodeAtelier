/**
 * 未开始/已完成发布的残留协调锁释放，供 Publisher 的显式恢复入口使用。
 * 1. readPublicationClaim 有界读取锁；未开始恢复只接受 v2 native claim 与明确锁 ID。
 * 2. 未开始分支要求 journal 不存在且 native 明确未开始来源写入；完成分支要求 complete 与执行/锁摘要匹配。
 * 3. 取得原生检查租约后再次复核前提，保存恢复决定，再按原生句柄释放固定锁；不写来源。
 * 4. 保留私有内容/批次目录；缺失锁幂等返回，替换锁不操作，旧格式/损坏证据不猜测修复。
 * 5. tracing 只记录模式、ID、耗时和结果；没有文件正文、路径、锁摘要或进程命令。
 * journal 创建前尚未建立匹配执行记录的情况继续拒绝，不以 PID 单项推断执行完毕。
 */
import path from "node:path";
import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import { TraceRecorder } from "../../tracing/recorder.js";
import type { TraceStatus } from "../../tracing/types.js";
import { digest, durableJson, snapshot, sourceIdentity } from "./files.js";
import { loadJournal } from "./journal.js";
import { PublicationLease } from "./publication-lease.js";
import { PublishError } from "./merge.js";
import type { Batch } from "./session.js";

const claimSchema = z.object({
  version: z.literal(2),
  kind: z.literal("native"),
  id: z.uuid(),
  pid: z.number().int().positive(),
  batchId: z.uuid(),
});

async function lockSnapshot(directory: string) {
  const value = await snapshot(await sourceIdentity(directory), "publish.lock");

  return value.content === null
    ? null
    : { value, hash: digest(Buffer.from(value.content, "base64")) };
}

export async function readPublicationClaim(directory: string) {
  const lock = await lockSnapshot(directory);

  return lock
    ? claimSchema.parse(
        JSON.parse(Buffer.from(lock.value.content!, "base64").toString("utf8")),
      )
    : null;
}

async function requireAbsentJournal(directory: string, batchId: string) {
  try {
    const folder = await lstat(path.join(directory, batchId));
    if (!folder.isDirectory() || folder.isSymbolicLink()) {
      throw new PublishError("RECOVERY_BATCH_PATH_INVALID");
    }

    await lstat(path.join(directory, batchId, "journal.json"));
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  throw new PublishError("RECOVERY_JOURNAL_EXISTS");
}

export async function releaseResidualLock(options: {
  directory: string;
  log: Logger;
  signal?: AbortSignal;
  target:
    { kind: "unstarted"; id: string } | { kind: "complete"; batch: Batch };
}) {
  const { directory, log, signal, target } = options;
  if (target.kind === "unstarted") {
    z.uuid().parse(target.id);
  }

  const task = randomUUID();
  const traces = new TraceRecorder();
  traces.startTask(task, task);
  const span = traces.startSpan(task, {
    name: "local_overlay.residual_lock_release",
    category: "workspace",
    track: "Publication recovery",
    attributes: { mode: target.kind },
  });
  const started = performance.now();
  let outcome: TraceStatus = "error";
  let lease: PublicationLease | undefined;
  let executing = false;
  log.info({
    module: "local-publication",
    event: "residual_lock_started",
    operationId: task,
    mode: target.kind,
  });
  try {
    signal?.throwIfAborted();
    const lock = await lockSnapshot(directory);
    if (!lock) {
      outcome = "ok";

      return { released: false };
    }

    let generation: string;
    let batchId: string;
    let verify: () => Promise<void>;
    if (target.kind === "unstarted") {
      const claim = await readPublicationClaim(directory);
      if (!claim || claim.id !== target.id) {
        throw new PublishError("RECOVERY_LOCK_CHANGED");
      }

      generation = claim.id;
      batchId = claim.batchId;
      verify = () => requireAbsentJournal(directory, batchId);
    } else {
      batchId = target.batch.id;
      const file = path.join(directory, batchId, "journal.json");
      const original = await loadJournal(file, target.batch);
      if (
        original.journal.state !== "complete" ||
        !original.journal.execution?.lockDigest
      ) {
        throw new PublishError("RECOVERY_NOT_COMPLETE_WITH_PROOF");
      }

      if (original.journal.execution.lockDigest !== lock.hash) {
        outcome = "ok";

        return { released: false };
      }

      generation = original.journal.execution.generation;
      verify = async () => {
        if (
          (await loadJournal(file, target.batch)).version !== original.version
        ) {
          throw new PublishError("JOURNAL_CHANGED");
        }
      };
    }

    await verify();
    lease = await PublicationLease.start(
      path.join(directory, "execution.lease"),
      generation,
    );
    if (target.kind === "unstarted" && lease.sourceMutationStarted !== false) {
      throw new PublishError("RECOVERY_SOURCE_MAY_HAVE_CHANGED");
    }

    const active = signal
      ? AbortSignal.any([signal, lease.signal])
      : lease.signal;
    active.throwIfAborted();
    await verify();
    if ((await lockSnapshot(directory))?.value.version !== lock.value.version) {
      throw new PublishError("RECOVERY_LOCK_CHANGED");
    }

    const decision = {
      version: 1,
      mode: target.kind,
      generation,
      batchId,
      lockDigest: lock.hash,
      state: "intent",
    };
    const receipt = path.join(directory, `lock-release-${task}.json`);
    await durableJson(receipt, decision);
    active.throwIfAborted();
    executing = true;
    await lease.releaseLock(lock.hash);
    decision.state = "confirmed";
    await durableJson(receipt, decision);
    outcome = "ok";

    return { released: true };
  } catch (error) {
    outcome = executing ? "unknown" : signal?.aborted ? "cancelled" : "error";
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
          path.join(directory, `lock-release-trace-${task}.json`),
          traces.exportTask(task),
        );
      } catch {
        log.warn({
          module: "local-publication",
          event: "residual_trace_failed",
          operationId: task,
        });
      }

      traces.discardTask(task);
      log.info({
        module: "local-publication",
        event: "residual_lock_finished",
        operationId: task,
        mode: target.kind,
        outcome,
        durationMs: performance.now() - started,
      });
    }
  }
}
