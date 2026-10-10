/**
 * 实现安装版 Agent Runtime 的固定 Node.js 入口，不读取宿主配置、模型凭据或测试环境变量。
 * Sandbox Supervisor 只把一个随机本机 pipe 名放入固定 argv；Runtime 连接后从该 pipe 的有界首帧取得 identity/nonce，并继续复用同一字节流运行 Runtime IPC。
 *
 * 1. 先校验 pipe 名称并建立本机 Named Pipe 连接；连接错误只返回固定类别，不泄露路径或启动材料。
 * 2. 将同一个 socket 的 input/output 交给 runAgentRuntimeTransport，共用首帧、握手和 AgentRuntimeService 生命周期。
 * 3. 本模块只持有 Windows 连接建立逻辑；失败销毁 pipe，共同入口负责连接后的退出与流清理。
 * 4. stderr 只输出固定启动阶段，不记录启动描述符、路径、nonce 或 IPC 内容，供宿主区分帧与握手失败。
 *
 * native Supervisor 必须在发送首帧前完成联合身份验证并代理 Broker 字节流；仅调用本入口不能证明 W3 身份边界完成。
 */

import net from "node:net";
import { runAgentRuntimeTransport } from "./agent-runtime-streams.js";
import { validateRuntimeStartupPipeName } from "./runtime-startup-protocol.js";

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

  try {
    await connected;
    await runAgentRuntimeTransport({ input: socket, output: socket }, signal);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
