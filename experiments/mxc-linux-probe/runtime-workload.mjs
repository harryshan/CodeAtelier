/**
 * 供真实 Agent Runtime 的 run_command 工具调用的固定 Linux 夹具，不使用模型任意代码或真实秘密。
 * 1. once 验证假 Broker 环境/私有文件不可达，写入自己工作区，分别输出 stdout/stderr 与 network namespace。
 * 2. loop 生成普通心跳和 detached Node 后代，供取消、IPC 断连、Runtime kill 的清理验证。
 * 3. heartbeat 仅写当前夹具目录，最长 15 秒自动停止；此期限只防实验泄漏，不是产品工具超时。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [action, privateFile] = process.argv.slice(2);
if (action === "once") {
  assert.equal(process.env.MXC_FAKE_BROKER_SECRET, undefined);
  assert.throws(() => fs.readFileSync(privateFile));
  fs.writeFileSync("command.txt", "command-executed-in-runtime");
  process.stdout.write(`IPC_TOOL_OK ${fs.readlinkSync("/proc/self/ns/net")}\n`);
  process.stderr.write("IPC_TOOL_STDERR\n");
} else if (action === "loop" || action === "heartbeat") {
  if (action === "loop") {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "heartbeat"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  }

  const target = action === "loop" ? "beat-parent" : "beat-child";
  const timer = setInterval(
    () => fs.writeFileSync(target, String(Date.now())),
    60,
  );
  setTimeout(() => clearInterval(timer), 15000);
} else {
  throw new Error("Unknown fixed fixture action");
}
