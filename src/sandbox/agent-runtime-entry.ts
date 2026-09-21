/**
 * 实现安装版 Agent Runtime 的固定 Node.js 入口，不读取宿主配置、模型凭据或测试环境变量。
 * Sandbox Supervisor 只把一个随机本机 pipe 名放入固定 argv；Runtime 连接后从该 pipe 的有界首帧取得 identity/nonce，并继续复用同一字节流运行 Runtime IPC。
 *
 * 1. 先校验 pipe 名称并建立本机 Named Pipe 连接；连接错误只返回固定类别，不泄露路径或启动材料。
 * 2. 从 Supervisor 首帧读取严格启动描述符，随后完成 Runtime→Broker 握手。
 * 3. 握手成功才创建 AgentRuntimeService 并报告 ready；pipe 断开会结束进程，不另开宿主能力通道。
 *
 * native Supervisor 必须在发送首帧前完成联合身份验证并代理 Broker 字节流；仅调用本入口不能证明 W3 身份边界完成。
 */

import net from "node:net";
import { connectAgentRuntime } from "./agent-runtime-connection.js";
import { AgentRuntimeService } from "./agent-runtime-service.js";
import {
  readRuntimeStartupDescriptor,
  validateRuntimeStartupPipeName,
} from "./runtime-startup-protocol.js";

export async function runAgentRuntimeEntry(
  pipeName: string,
  signal: AbortSignal,
) {
  const verifiedPipeName = validateRuntimeStartupPipeName(pipeName);
  signal.throwIfAborted();
  const socket = net.createConnection(verifiedPipeName);
  const connected = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Agent Runtime 无法连接 Supervisor 启动 pipe。"));
    };

    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(signal.reason ?? new Error("Agent Runtime 启动已取消。"));
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  await connected;
  const descriptor = await readRuntimeStartupDescriptor(socket, signal);
  const peer = await connectAgentRuntime(
    { input: socket, output: socket },
    descriptor.identity,
    descriptor.nonce,
    signal,
  );

  new AgentRuntimeService(peer, descriptor.identity);
  peer.event({ type: "event", event: "runtime_state", state: "ready" });

  return new Promise<void>((resolve, reject) => {
    socket.once("end", resolve);
    socket.once("error", reject);
  });
}
