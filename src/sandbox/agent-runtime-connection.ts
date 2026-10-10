/**
 * 在 Agent Runtime 进程内完成 Runtime IPC nonce/instance 握手，并只在 Broker 确认后暴露可用 peer。
 * 启动器必须从 Sandbox Supervisor 的私有启动材料取得 identity/nonce；本模块不会从工作区配置或模型输入读取它们。
 *
 * 1. connect 先创建有界 RuntimeIpcPeer，再发送 runtime_hello。
 * 2. broker_hello 必须匹配协议版本和 executionInstanceId；错误方向、重复或断连都拒绝启动 agent loop。
 * 3. 握手只补充 replay/路由证明，不能替代 Windows transport 对 PID、Job、token 和 generation 的联合验证。
 */

import type { RuntimeIpcTransport } from "./runtime-ipc-peer.js";
import {
  RUNTIME_IPC_PROTOCOL_VERSION,
  type RuntimeIpcMessage,
} from "./runtime-ipc-protocol.js";
import { RuntimeIpcError, RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type { RuntimeExecutionIdentity } from "./runtime-capability-core.js";

export async function connectAgentRuntime(
  streams: RuntimeIpcTransport,
  identity: RuntimeExecutionIdentity,
  nonce: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let resolveHandshake!: () => void;
  let rejectHandshake!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });
  let settled = false;
  const peer = new RuntimeIpcPeer({
    ...streams,
    onClose: (error) => {
      if (!settled) {
        settled = true;
        rejectHandshake(error);
      }
    },
    onHandshake: (
      message: Extract<
        RuntimeIpcMessage,
        { type: "broker_hello" | "runtime_hello" }
      >,
    ) => {
      if (
        settled ||
        message.type !== "broker_hello" ||
        message.executionInstanceId !== identity.executionInstanceId
      ) {
        const error = new RuntimeIpcError("Broker IPC 握手身份不匹配。");
        settled = true;
        rejectHandshake(error);
        peer.end(error.message);

        return;
      }

      settled = true;
      resolveHandshake();
    },
  });
  const aborted = () => {
    if (!settled) {
      settled = true;
      rejectHandshake(
        signal.reason instanceof Error
          ? signal.reason
          : new RuntimeIpcError("Runtime IPC 握手已取消。"),
      );
    }

    peer.end("Runtime IPC 握手已取消。");
  };

  signal.addEventListener("abort", aborted, { once: true });
  peer.handshake({
    type: "runtime_hello",
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    sessionId: identity.sessionId,
    taskId: identity.taskId,
    executionInstanceId: identity.executionInstanceId,
    nonce,
  });
  try {
    await handshake;

    return peer;
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
