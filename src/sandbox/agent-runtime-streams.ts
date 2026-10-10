/**
 * 在平台启动器交付的 RuntimeIpcTransport 上运行共同的 Agent Runtime 启动及服务生命周期。
 * Windows entry 传入已连接的 Named Pipe；Linux 手动原型传入启动器专属 stdin/stdout，绝不从 argv/env 接收 nonce。
 * 1. runAgentRuntimeTransport 监视流关闭，读取有界启动首帧并完成现有 instance/nonce 握手。
 * 2. 握手后创建真实 AgentRuntimeService，发送 ready；signal 仅约束启动，不给运行任务增加总期限。
 * 3. EOF/流错误结束 IPC、取消未完成请求并销毁流；进程树清理和未知副作用对账仍归平台 launcher。
 * reportPhase 只接收固定阶段；任务/model/tool trace 仍由现有 Runtime IPC 回传，启动 trace 由 launcher 包围。
 * 这个接口不认证任意 socket，不新增产品 Linux 开关，也不降低 Windows Supervisor 身份校验。
 */

import { finished } from "node:stream/promises";
import { connectAgentRuntime } from "./agent-runtime-connection.js";
import { AgentRuntimeService } from "./agent-runtime-service.js";
import type {
  RuntimeIpcPeer,
  RuntimeIpcTransport,
} from "./runtime-ipc-peer.js";
import { readRuntimeStartupDescriptor } from "./runtime-startup-protocol.js";

export async function runAgentRuntimeTransport(
  transport: RuntimeIpcTransport,
  signal: AbortSignal,
  reportPhase: (phase: "descriptor" | "handshake") => void = (phase) => {
    process.stderr.write(`CODEATELIER_AGENT_RUNTIME_PHASE ${phase}\n`);
  },
) {
  const disconnected = new AbortController();
  const startupSignal = AbortSignal.any([signal, disconnected.signal]);
  const closed = finished(transport.input, {
    readable: true,
    writable: false,
    cleanup: true,
  }).finally(() => disconnected.abort(new Error("Runtime IPC 已断开。")));
  // 启动期间也可能关闭，立即处理拒绝；下方仍 await 同一结果，不隐藏失败。
  void closed.catch(() => undefined);
  const outputFailed = () => transport.input.destroy();
  transport.output.once("error", outputFailed);
  let peer: RuntimeIpcPeer | undefined;

  try {
    const descriptor = await readRuntimeStartupDescriptor(
      transport.input,
      startupSignal,
    );
    reportPhase("descriptor");
    peer = await connectAgentRuntime(
      transport,
      descriptor.identity,
      descriptor.nonce,
      startupSignal,
    );
    reportPhase("handshake");
    new AgentRuntimeService(peer, descriptor.identity);
    peer.event({ type: "event", event: "runtime_state", state: "ready" });
    await closed;
  } finally {
    peer?.end();
    transport.input.destroy();
    transport.output.destroy();
    transport.output.removeListener("error", outputFailed);
  }
}
