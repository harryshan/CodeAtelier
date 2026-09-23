/*
 * 管理服务进程内的全局 subagent Worker lease；宿主协调器直接调用，Windows Runtime 经 Broker
 * 身份绑定的 IPC 间接申请。跨工作区多任务共享此对象，不复用工具 DAG 或文件解析的 Worker 槽。
 *
 * 1. acquire 按任务排队，单任务最多两个活动 Worker，全局最多四个；等待可取消。
 * 2. release 幂等归还已确认退出的 Worker lease，再按任务轮转唤醒待处理项。
 * 3. cancelTask 只取消本任务的等待项；已经运行的 Worker 必须由协调器停止并 release。
 *
 * 此类不启动 Worker、不计量模型请求；调用方必须在实际线程退出或实例清理对账后归还。
 */

interface WaitingLease {
  taskId: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  abort: () => void;
}

export class SubagentLimits {
  private active = new Map<string, number>();
  private waiting = new Map<string, WaitingLease[]>();
  private rotation: string[] = [];
  private total = 0;

  constructor(
    private readonly maxWorkers = 4,
    private readonly maxPerTask = 2,
  ) {
    if (maxWorkers < 1 || maxPerTask < 1) {
      throw new Error("subagent 并发上限必须为正数。");
    }
  }

  acquire(taskId: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
      const request: WaitingLease = {
        taskId,
        resolve,
        reject,
        signal,
        abort: () => {
          this.remove(request);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("任务已取消。"),
          );
          this.dispatch();
        },
      };
      signal.addEventListener("abort", request.abort, { once: true });
      if (!this.waiting.has(taskId)) {
        this.waiting.set(taskId, []);
        this.rotation.push(taskId);
      }

      this.waiting.get(taskId)!.push(request);
      this.dispatch();
    });
  }

  cancelTask(taskId: string) {
    const queue = this.waiting.get(taskId) ?? [];
    for (const request of [...queue]) {
      this.remove(request);
      request.reject(new Error("任务已取消。"));
    }

    this.dispatch();
  }

  private remove(request: WaitingLease) {
    request.signal.removeEventListener("abort", request.abort);
    const queue = this.waiting.get(request.taskId);
    if (!queue) {
      return;
    }

    const index = queue.indexOf(request);
    if (index >= 0) {
      queue.splice(index, 1);
    }

    if (queue.length === 0) {
      this.waiting.delete(request.taskId);
      this.rotation = this.rotation.filter(
        (taskId) => taskId !== request.taskId,
      );
    }
  }

  private dispatch() {
    while (this.total < this.maxWorkers && this.rotation.length) {
      const next = this.rotation.find(
        (taskId) => (this.active.get(taskId) ?? 0) < this.maxPerTask,
      );
      if (!next) {
        return;
      }

      const request = this.waiting.get(next)![0];
      this.remove(request);
      if (this.waiting.has(next)) {
        this.rotation = this.rotation.filter((taskId) => taskId !== next);
        this.rotation.push(next);
      }

      this.total++;
      this.active.set(next, (this.active.get(next) ?? 0) + 1);
      let released = false;
      request.resolve(() => {
        if (released) {
          return;
        }

        released = true;
        this.total--;
        const remaining = this.active.get(next)! - 1;
        if (remaining === 0) {
          this.active.delete(next);
        } else {
          this.active.set(next, remaining);
        }

        this.dispatch();
      });
    }
  }
}
