/**
 * 从本地异步任务上下文观察宿主/Broker 命令终止，不读取命令、环境变量或输出。
 * 1. 创建时绑定当前工具 span，process.cancel 只在实际 stop 时开始。
 * 2. termination 记录 taskkill/信号发送结果；该结果不冒充后代清理证明。
 * 3. exit 记录直子进程 close 并结束取消等待，treeCleanup 始终 unknown；Sandbox Job 的清理由独立账本证明。
 * 无上下文的探针和 Runtime 本地命令不生成宿主伪造时间线。
 */
import { currentTraceContext } from "./context.js";
import type { TraceSpan } from "./types.js";
import { AsyncLocalStorage } from "node:async_hooks";

export interface ProcessObserver {
  stop(pid: number | undefined, aborted: boolean, timedOut: boolean): void;
  termination(method: string, accepted: boolean): void;
  exit(code: number | null): void;
}
const observers = new AsyncLocalStorage<() => ProcessObserver>();

export function withProcessObserver<T>(
  factory: () => ProcessObserver,
  operation: () => T,
): T {
  return observers.run(factory, operation);
}

export function processObserver(): ProcessObserver {
  const factory = observers.getStore();
  if (factory) {
    return factory();
  }

  const context = currentTraceContext();
  let cancellation: TraceSpan | undefined;
  let stopped = false;
  let cancelled = false;
  const instant = (
    name: string,
    attributes: { [key: string]: string | number | boolean | null | undefined },
  ) => {
    context?.recorder.instant(
      context.span.taskId,
      name,
      "process",
      "Process lifecycle",
      {
        ...attributes,
        callId: context.span.attributes.callId,
        parentSpanId: context.span.id,
      },
    );
  };

  return {
    stop(pid: number | undefined, aborted: boolean, timedOut: boolean) {
      if (stopped) {
        return;
      }

      stopped = true;
      cancelled = aborted;
      cancellation = context?.recorder.startSpan(context.span.taskId, {
        name: "process.cancel",
        category: "process",
        track: "Process lifecycle",
        parentSpanId: context.span.id,
        attributes: {
          pid,
          reason: aborted ? "cancel" : timedOut ? "timeout" : "failure",
          callId: context.span.attributes.callId,
        },
      });
    },
    termination(method: string, accepted: boolean) {
      instant("process.termination", {
        method,
        accepted,
        treeCleanup: "unknown",
      });
    },
    exit(code: number | null) {
      instant("process.direct_exit", {
        exitCode: code,
        stopRequested: stopped,
        treeCleanup: "unknown",
      });
      context?.recorder.endSpan(
        cancellation,
        cancelled ? "cancelled" : "error",
        { directChildExited: true, treeCleanup: "unknown" },
      );
    },
  };
}
