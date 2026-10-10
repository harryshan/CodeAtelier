/**
 * 为 probe.mjs 提供可被强制终止的独立 MXC 宿主，模拟 Broker 崩溃而不是调用正常 dispose。
 * 1. 从父夹具读取固定路径/随机标记，生成仅允许实验工作区、HOME/temp 与 Node 的 Bubblewrap 请求。
 * 2. 运行 workload.mjs 的 tree 场景，转发 ready 输出并等待；父夹具核对后以 SIGKILL 终止本进程。
 * 3. 正常退出仍释放 handle；SIGKILL 无法执行 finally，后代是否终止必须由父夹具通过 /proc/心跳证明。
 * 本文件仅供手动实验，不读取用户配置、不执行任意模型命令；短超时是防止测试故障留下持续写入。
 */

import path from "node:path";
import { spawn } from "@microsoft/mxc-sdk/v1";

const [encoded, token] = process.argv.slice(2);
const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const child = await spawn({
  containment: { type: "bubblewrap" },
  command: [
    process.execPath,
    config.workspace + "/workload.mjs",
    "tree",
    token,
    encoded,
  ]
    .map(quote)
    .join(" "),
  workingDirectory: config.workspace,
  filesystem: {
    readonlyPaths: [path.dirname(path.dirname(process.execPath))],
    readwritePaths: [config.workspace, config.home, config.temp],
  },
  environment: {
    HOME: config.home,
    TMPDIR: config.temp,
    PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
  },
  inheritDefaultEnvironment: false,
  network: {
    egress: { default: "deny" },
    ingress: { default: "deny", hostLoopback: "deny" },
  },
  timeoutMs: 20000,
});
child.standardOutput.pipe(process.stdout);
child.standardError.pipe(process.stderr);
try {
  await child.wait();
} finally {
  child.dispose();
}
