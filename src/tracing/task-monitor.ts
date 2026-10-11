/**
 * 管理任务从排队到归档的诊断生命周期，由 Engine 创建并在提交、领取和终态调用。
 * 1. submitted/waiting/started 记录调度等待原因及真实领取边界，不保存工作区路径。
 * 2. 单个低频计时器采样 Broker 进程 CPU/RSS/event-loop delay，并按周期写原子检查点。
 * 3. finish 等待已有检查点写入，再归档终态、删除成功归档对应的检查点并释放记录。
 * 4. stop 关闭计时器和采样器；所有后台 I/O 故障隔离于产品任务，不恢复或重放任务。
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Logger } from "pino";
import type { TraceRecorder } from "./recorder.js";
import type { TraceArchive } from "./archive.js";
import type { TraceSpan, TraceStatus } from "./types.js";

export class TraceTaskMonitor {
  private tasks = new Map<
    string,
    {
      sessionId: string;
      queue?: TraceSpan;
      reason?: string;
      checkpoint?: Promise<void>;
      savedAt: number;
    }
  >();

  private timer?: ReturnType<typeof setInterval>;
  private delay = monitorEventLoopDelay({ resolution: 20 });
  private cpu = process.cpuUsage();
  private sampledAt = performance.now();
  private finishing = new Map<string, Promise<void>>();

  constructor(
    private recorder: TraceRecorder,
    private archive: TraceArchive,
    private log: Logger,
    private checkpointMs = 30000,
  ) {}

  submitted(taskId: string, sessionId: string) {
    if (this.tasks.has(taskId)) {
      return;
    }

    this.recorder.startTask(taskId, sessionId);
    this.tasks.set(taskId, { sessionId, savedAt: 0 });
    if (!this.timer) {
      this.cpu = process.cpuUsage();
      this.sampledAt = performance.now();
      this.delay.enable();
      this.timer = setInterval(() => this.sample(), 5000);
      this.timer.unref();
    }

    this.checkpoint(taskId);
  }

  waiting(taskId: string, reason: "workspace" | "capacity" | "ready") {
    const task = this.tasks.get(taskId);
    if (!task || task.reason === reason) {
      return;
    }

    this.recorder.endSpan(task.queue, "ok");
    task.reason = reason;
    task.queue = this.recorder.startSpan(taskId, {
      name: "task.queue",
      category: "scheduler",
      track: "Task scheduler",
      attributes: { reason },
    });
  }

  started(taskId: string) {
    const task = this.tasks.get(taskId);
    this.recorder.endSpan(task?.queue, "ok", { claimed: true });
    if (task) {
      task.queue = undefined;
      task.reason = undefined;
    }
  }

  private sample() {
    const now = performance.now();
    const usage = process.cpuUsage(this.cpu);
    const memory = process.memoryUsage();
    const values = {
      cpuPercent: (usage.user + usage.system) / ((now - this.sampledAt) * 10),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopDelayMaxMs: this.delay.max / 1e6,
      activeTraces: this.tasks.size,
      queuedTraces: [...this.tasks.values()].filter((task) => task.queue)
        .length,
    };
    this.cpu = process.cpuUsage();
    this.sampledAt = now;
    this.delay.reset();
    for (const taskId of this.tasks.keys()) {
      this.recorder.counter(
        taskId,
        "process.resources",
        "Process resources",
        values,
      );
      this.checkpoint(taskId);
    }
  }

  private checkpoint(taskId: string) {
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.checkpoint ||
      Date.now() - task.savedAt < this.checkpointMs
    ) {
      return;
    }

    task.savedAt = Date.now();
    task.checkpoint = Promise.resolve()
      .then(async () => {
        const trace = this.recorder.exportTask(taskId);
        if (trace) {
          await this.archive.writeCheckpoint(task.sessionId, taskId, trace);
        }
      })
      .catch((error) =>
        this.log.warn({
          event: "tracing.checkpoint_failed",
          taskId,
          err: error,
        }),
      )
      .finally(() => {
        task.checkpoint = undefined;
      });
  }

  finish(taskId: string, sessionId: string, status: TraceStatus) {
    const existing = this.finishing.get(taskId);
    if (existing) {
      return existing;
    }

    const done = this.finalize(taskId, sessionId, status).finally(() =>
      this.finishing.delete(taskId),
    );
    this.finishing.set(taskId, done);

    return done;
  }

  async drain() {
    await Promise.all(this.finishing.values());
  }

  private async finalize(
    taskId: string,
    sessionId: string,
    status: TraceStatus,
  ) {
    const task = this.tasks.get(taskId);
    this.tasks.delete(taskId);
    try {
      await task?.checkpoint;
      this.recorder.finishTask(taskId, status);
      const trace = this.recorder.exportTask(taskId);
      if (trace && (await this.archive.write(sessionId, taskId, trace))) {
        await this.archive.removeCheckpoint(sessionId, taskId);
      }
    } catch (error) {
      this.log.warn({ event: "tracing.finalize_failed", taskId, err: error });
    } finally {
      this.recorder.discardTask(taskId);
      if (!this.tasks.size) {
        this.stop();
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.delay.disable();
  }
}
