/**
 * 为统一 IPC 回归与手动 MXC Linux 实验提供固定 stdio 入口，不注册产品 Sandbox 后端。
 * 1. stdin/stdout 专用于启动首帧和 Runtime IPC，调用生产 runAgentRuntimeTransport；没有测试 env 身份旁路。
 * 2. 启动期限只限制首帧/握手；AgentRuntimeService 的任务取消继续由 Broker 请求控制。
 * 3. 失败只写固定 stderr 类别并设置非零退出；启动器负责收尾进程树，不把 EOF 当成任务成功。
 */

import { runAgentRuntimeTransport } from "../../src/sandbox/agent-runtime-streams.js";

await runAgentRuntimeTransport(
  { input: process.stdin, output: process.stdout },
  AbortSignal.timeout(15_000),
).catch(() => {
  process.stderr.write("CODEATELIER_AGENT_RUNTIME_STREAM_FAILED\n");
  process.exitCode = 1;
});
