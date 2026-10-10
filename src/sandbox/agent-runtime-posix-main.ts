/**
 * MXC 固定 bundle 的 POSIX 产品入口；由 Broker 以私有 stdin/stdout 启动，不提供任意 listener。
 * 1. 拒绝非 Linux/macOS、额外 argv 或 TTY，nonce/任务身份只接受共同启动首帧。
 * 2. 复用 runAgentRuntimeTransport 的启动、握手和真实服务；30 秒只约束启动，不限制任务总时长。
 * 3. stdout 仅作协议，stderr 仅输出固定错误；OS 后端及进程树释放由 MXC launcher 负责。
 */

import { runAgentRuntimeTransport } from "./agent-runtime-streams.js";

if (
  !["linux", "darwin"].includes(process.platform) ||
  process.argv.length !== 2 ||
  process.stdin.isTTY ||
  process.stdout.isTTY
) {
  throw new Error("POSIX Agent Runtime 只接受启动器私有管道。");
}

await runAgentRuntimeTransport(
  { input: process.stdin, output: process.stdout },
  AbortSignal.timeout(30_000),
).catch(() => {
  process.stderr.write("CODEATELIER_AGENT_RUNTIME_STARTUP_FAILED\n");
  process.exitCode = 1;
});
