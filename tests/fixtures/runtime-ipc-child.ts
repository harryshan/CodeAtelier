/**
 * 作为 runtime-ipc.test.ts 的独立 Node 子进程，证明请求和流式事件确实跨越进程 stdio。
 * 它不运行于专用账户，也不验证 Windows 身份，因此只能称为 transport test harness，不能计入 W3。
 *
 * 1. 连接继承的 stdin/stdout 并请求一次 brokered model_run。
 * 2. 收集与 requestId 关联的 model_delta，核对最终结果后发送 runtime_state。
 * 3. 任一失败写入 stderr 并设置非零退出码；stdout 始终只承载协议帧。
 */

import { RuntimeModelProvider } from "../../src/sandbox/runtime-model-provider.js";
import { connectAgentRuntime } from "../../src/sandbox/agent-runtime-connection.js";

const controller = new AbortController();
const deltas: string[] = [];
const peer = await connectAgentRuntime(
  { input: process.stdin, output: process.stdout },
  {
    sessionId: "session-1",
    taskId: "task-1",
    executionInstanceId: "runtime-1",
    kind: "agent-runtime",
  },
  "0123456789abcdef0123456789abcdef",
  controller.signal,
);
const provider = new RuntimeModelProvider(peer, "task");

try {
  const capabilities = await provider.getCapabilities(controller.signal);
  const result = await provider.run(
    [{ role: "user", content: "test" }],
    "fixture",
    [],
    controller.signal,
    (text) => deltas.push(text),
    { maxOutputTokens: 32 },
  );
  if (
    result.text !== "hello" ||
    deltas.join("") !== "hello" ||
    capabilities?.limits.max_context_window_tokens !== 4096
  ) {
    throw new Error("跨进程模型流与最终结果不一致。");
  }

  await peer.request(
    "runtime_complete",
    { status: "completed" },
    controller.signal,
  );
  peer.event({ type: "event", event: "runtime_state", state: "stopping" });
  peer.end();
  process.stdin.destroy();
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  peer.end("Runtime IPC fixture 失败。");
  process.stdin.destroy();
}
