/**
 * 将 Runtime 命令取消观察转换成白名单 trace IPC，供 AgentRuntimeService 的工具上下文使用。
 * 1. 每次执行创建独立 observer，绑定已登记 callId；只发送 PID、结果和固定类别，不带命令或输出。
 * 2. cancel 持续到直子 close；termination/direct_exit 是零时长事件，不宣称 Job 或后代清理完成。
 * 3. 断连后的诊断发送失败被忽略，不能中断既有进程终止逻辑；可信清理结果仍由 Broker 账本决定。
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ProcessObserver } from "../tracing/process-observer.js";
import type { RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type { RuntimeIpcEvent } from "./runtime-ipc-protocol.js";

export function runtimeProcessTrace(
  peer: RuntimeIpcPeer,
  callId: string,
): ProcessObserver {
  let cancellation: string | undefined;
  let cancelled = false;
  const now = () =>
    Math.round((performance.timeOrigin + performance.now()) * 1000);
  const send = (event: RuntimeIpcEvent) => {
    try {
      peer.event(event);
    } catch {
      /* 断连不能阻碍进程清理。 */
    }
  };

  const start = (
    name: "process.cancel" | "process.termination" | "process.direct_exit",
    attributes: Extract<
      RuntimeIpcEvent,
      { event: "trace_span_start" }
    >["attributes"],
  ) => {
    const spanId = randomUUID();
    send({
      type: "event",
      event: "trace_span_start",
      spanId,
      timestampUs: now(),
      name,
      attributes: { callId, ...attributes },
    });

    return spanId;
  };

  const end = (spanId: string, status: "ok" | "cancelled" | "error") =>
    send({
      type: "event",
      event: "trace_span_end",
      spanId,
      timestampUs: now(),
      status,
      attributes: {},
    });

  return {
    stop(pid, aborted, timedOut) {
      cancelled = aborted;
      cancellation = start("process.cancel", {
        pid,
        stopReason: aborted ? "cancel" : timedOut ? "timeout" : "failure",
      });
    },
    termination(method, accepted) {
      end(
        start("process.termination", {
          terminationMethod:
            method === "taskkill" ? "taskkill" : "process-group",
          accepted,
          treeCleanup: "unknown",
        }),
        accepted ? "ok" : "error",
      );
    },
    exit(exitCode) {
      end(
        start("process.direct_exit", { exitCode, treeCleanup: "unknown" }),
        "ok",
      );
      if (cancellation) {
        end(cancellation, cancelled ? "cancelled" : "error");
      }
    },
  };
}
