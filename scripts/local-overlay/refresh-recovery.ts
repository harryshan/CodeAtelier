/**
 * 恢复来源已完整发布但私有视图尚未确认的批次，由 Publisher 在冻结回调内调用。
 * 1. 先只读校验 complete，再获取正常来源锁并重读；不接管未知锁，不重放来源写入。
 * 2. 原生收据或私有检查点产生安全确认请求；先记录恢复 intent，再等待 helper 确认后落盘。
 * 3. 重复已确认恢复直接返回；丢失回执仍保留 pending 和原始/历次请求，下一次不能猜测成功。
 * 4. 恢复 trace 独立保存，记录 ID/状态/耗时而不记录路径、正文或文件版本摘要。
 * 限制为干净 Local v6 视图；unknown/applying、dirty 卷、过大/损坏日志和后来私有修改均拒绝。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { TraceRecorder } from "../../src/tracing/recorder.js";
import type { TraceStatus } from "../../src/tracing/types.js";
import type { OverlayAcknowledgement } from "../../src/worktrees/overlay.js";
import { durableJson } from "./files.js";
import { loadJournal, saveJournal } from "./journal.js";
import { PublishError } from "./merge.js";
import { nativeRefreshRequest } from "./native-refresh.js";
import type { Batch } from "./session.js";

export async function recoverCompletedRefresh(options: {
  batch: Batch;
  directory: string;
  control: string;
  signal?: AbortSignal;
  log: Logger;
  acquire: () => Promise<() => Promise<void>>;
  acknowledge: (request: OverlayAcknowledgement) => Promise<void>;
}) {
  const { batch, directory, control, signal, log } = options;
  const file = path.join(directory, "journal.json");
  const traces = new TraceRecorder();
  const operationId = randomUUID();
  traces.startTask(operationId, batch.id);
  const span = traces.startSpan(operationId, {
    name: "local_overlay.recover_refresh",
    category: "workspace",
    track: "Local recovery",
    attributes: { batchId: batch.id },
  });
  const started = performance.now();
  let outcome: TraceStatus = "error";
  let release: (() => Promise<void>) | undefined;
  let intent = false;
  log.info({
    module: "local-overlay-poc",
    event: "refresh_recovery_started",
    batchId: batch.id,
    operationId,
  });
  try {
    signal?.throwIfAborted();
    const before = await loadJournal(file, batch);
    if (before.journal.state !== "complete" || !before.journal.refresh) {
      throw new PublishError("REFRESH_NOT_COMPLETE");
    }

    release = await options.acquire();
    const loaded = await loadJournal(file, batch);
    const journal = loaded.journal;
    let version = loaded.version;
    if (journal.state !== "complete" || !journal.refresh) {
      throw new PublishError("REFRESH_NOT_COMPLETE");
    }

    if (journal.refresh.state === "confirmed") {
      outcome = "ok";

      return { directory, alreadyConfirmed: true };
    }

    const attempts = (journal.refresh.attempts ??= []);
    if (attempts.length >= 100) {
      throw new PublishError("RECOVERY_ATTEMPT_LIMIT");
    }

    const previous = attempts.at(-1)?.request ?? journal.refresh.request;
    const request = await nativeRefreshRequest(
      batch.source,
      control,
      previous,
      journal.refresh.checkpoint,
    );
    signal?.throwIfAborted();
    const attempt = { request, state: "intent" as "intent" | "confirmed" };
    attempts.push(attempt);
    version = await saveJournal(file, journal, version);
    signal?.throwIfAborted();
    intent = true;
    await options.acknowledge(request);
    attempt.state = "confirmed";
    journal.refresh.state = "confirmed";
    await saveJournal(file, journal, version);
    outcome = "ok";

    return { directory, alreadyConfirmed: false };
  } catch (error) {
    outcome = intent ? "unknown" : signal?.aborted ? "cancelled" : "error";
    throw error;
  } finally {
    try {
      await release?.();
    } catch (error) {
      outcome = "unknown";
      throw error;
    } finally {
      traces.endSpan(span, outcome);
      traces.finishTask(operationId, outcome);
      try {
        await durableJson(
          path.join(directory, `recovery-trace-${operationId}.json`),
          traces.exportTask(operationId),
        );
      } catch {
        log.warn({
          module: "local-overlay-poc",
          event: "recovery_trace_failed",
          batchId: batch.id,
          operationId,
        });
      }

      traces.discardTask(operationId);
      log.info({
        module: "local-overlay-poc",
        event: "refresh_recovery_finished",
        batchId: batch.id,
        operationId,
        outcome,
        durationMs: performance.now() - started,
      });
    }
  }
}
