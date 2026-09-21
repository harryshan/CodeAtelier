/**
 * 定义 Broker Host 启动常驻 Agent Runtime 所需的最小进程契约。
 * Windows 产品实现必须由 Sandbox Supervisor 创建专用账户 restricted token/Job 并返回已认证 Runtime IPC 字节流；测试实现可用普通子进程，但必须明确不构成 Sandbox 证据。
 *
 * 1. launch 输入只含 Broker 生成的任务/instance/nonce 和工作区，不能接受模型提供的 executable 或 argv。
 * 2. 返回流在 launcher 完成 PID/创建时间、Job、token/capability、generation 和 nonce 绑定后才可使用。
 * 3. close 必须等待进程树与租约清理并返回 clean/orphaned；orphaned 触发 generation 隔离，不能按正常取消处理。
 */

import type { Readable, Writable } from "node:stream";
import type { RuntimeExecutionIdentity } from "./runtime-capability-core.js";

export interface LaunchedAgentRuntime {
  input: Readable;
  output: Writable;
  pid: number;
  processCreationTime100ns?: string;
  accountGenerationDigest?: string;
  close(
    reason: "completed" | "cancel" | "shutdown" | "failed",
  ): Promise<"clean" | "orphaned">;
}

export interface AgentRuntimeLauncher {
  launch(input: {
    identity: RuntimeExecutionIdentity;
    nonce: string;
    workspace: string;
    signal: AbortSignal;
  }): Promise<LaunchedAgentRuntime>;
}
