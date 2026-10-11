/**
 * 在宿主异步调用链上传递诊断归属，供进程、审批和存储获取当前任务/工具 ID。
 * 1. withTraceContext 只在回调生命周期内绑定 recorder 和父 span，独立并发分支不会互相覆盖。
 * 2. currentTraceContext 返回可选绑定；没有任务的后台操作不创建伪造任务。
 * 3. 绑定不携带提示词、命令、凭据，不跨 IPC 自动授予或传播权限。
 * 4. withTraceCall 为无本地 Recorder 的 Runtime 绑定工具 ID，仅供发送有界诊断关联。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceRecorder } from "./recorder.js";
import type { TraceSpan } from "./types.js";

const context = new AsyncLocalStorage<{
  recorder: TraceRecorder;
  span: TraceSpan;
}>();

export const currentTraceContext = () => context.getStore();
const calls = new AsyncLocalStorage<string>();
export const currentTraceCallId = () => calls.getStore();
export function withTraceCall<T>(callId: string, operation: () => T): T {
  return calls.run(callId, operation);
}

export function withTraceContext<T>(
  recorder: TraceRecorder,
  span: TraceSpan | undefined,
  operation: () => T,
): T {
  return span ? context.run({ recorder, span }, operation) : operation();
}
