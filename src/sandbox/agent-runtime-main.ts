/**
 * 启动 Windows 安装版 Agent Runtime；该文件由受保护的 Sandbox Supervisor 以固定 Node executable 和固定脚本路径调用。
 * argv 只允许携带任务专属本机启动 pipe 名，真正的 identity/nonce 由 pipe 首帧交付；任何启动失败都以固定诊断退出。
 */

import { runAgentRuntimeEntry } from "./agent-runtime-entry.js";

if (process.platform !== "win32" || process.argv.length !== 3) {
  throw new Error("Agent Runtime 产品入口只接受 Windows Supervisor 启动。 ");
}

await runAgentRuntimeEntry(process.argv[2]!, AbortSignal.timeout(30_000)).catch(
  () => {
    process.stderr.write("CODEATELIER_AGENT_RUNTIME_STARTUP_FAILED\n");
    process.exitCode = 1;
  },
);
