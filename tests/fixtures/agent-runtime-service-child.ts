/**
 * 作为 agent-runtime-service.test.ts 的独立 Node Agent Runtime test harness。
 * 它完成 instance/nonce 握手并运行 AgentRuntimeService，但不使用 Windows 专用账户或真实 Named Pipe，不能作为 W3/W4 平台证据。
 *
 * 1. stdin/stdout 只承载 Runtime IPC，身份值由测试 launcher 通过专用环境变量提供。
 * 2. AgentRuntimeService 接收 Broker 的 start_task，在本子进程执行 agent loop 和本地文件工具。
 * 3. Broker 关闭通道后进程退出；错误由协议终态报告，stderr 保留给夹具崩溃诊断。
 */

import { connectAgentRuntime } from "../../src/sandbox/agent-runtime-connection.js";
import { AgentRuntimeService } from "../../src/sandbox/agent-runtime-service.js";

const descriptor = JSON.parse(
  process.env.CODEATELIER_TEST_RUNTIME_DESCRIPTOR ?? "null",
) as {
  identity: {
    sessionId: string;
    taskId: string;
    executionInstanceId: string;
    kind: "agent-runtime";
  };
  nonce: string;
} | null;
if (!descriptor) {
  throw new Error("测试 Agent Runtime 缺少启动描述符。");
}

const { identity, nonce } = descriptor;
const peer = await connectAgentRuntime(
  { input: process.stdin, output: process.stdout },
  identity,
  nonce,
  AbortSignal.timeout(15_000),
);
new AgentRuntimeService(peer, identity);
peer.event({ type: "event", event: "runtime_state", state: "ready" });
process.stdin.resume();
await new Promise<void>((resolve) => process.stdin.once("end", resolve));
