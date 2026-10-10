/**
 * MXC Linux 手动验证的受限子进程；由 probe.mjs 经固定 Node 路径启动，不接收模型输入。
 * 输入为操作名、随机测试标记及 base64 JSON 夹具路径；输出仅包含夹具结果，不读真实凭据。
 * 1. connect 检查 TCP/UNIX socket 的真实连通性，并以短期限关闭自己的 socket。
 * 2. filesystem 验证授权读写、拒绝根、链接和环境；workers 验证 Node Worker/子进程。
 * 3. network 对照宿主 listener 与沙箱内部 loopback；echo 处理多轮 stdio 消息。
 * 4. tree/heartbeat 创建有界数量的 detached 后代，仅向专属夹具写心跳，供取消/超时测试。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";

const [action, token, encoded] = process.argv.slice(2);
const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

function connect(options) {
  return new Promise((resolve) => {
    const socket = net.createConnection(options);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(1500, () => done("timeout"));
    socket.once("connect", () => done("connected"));
    socket.once("error", (error) => done(error.code));
  });
}

function denied(operation) {
  assert.throws(operation, (error) =>
    ["ENOENT", "EACCES", "EPERM", "EROFS"].includes(error.code),
  );
}

async function filesystem() {
  assert.equal(fs.readFileSync(config.readonly + "/input", "utf8"), "readonly");
  denied(() => fs.writeFileSync(config.readonly + "/input", "bad"));
  denied(() => fs.readFileSync(config.private + "/secret", "utf8"));
  denied(() => fs.writeFileSync(config.private + "/outside", "bad"));
  denied(() => fs.readFileSync(config.workspace + "/denied/secret", "utf8"));
  // denied 目录是空 tmpfs：原内容不可见，影子写入成功但不得改变宿主见证文件。
  fs.writeFileSync(config.workspace + "/denied/secret", "shadow-only");
  assert.equal(
    fs.readFileSync(config.workspace + "/denied/secret", "utf8"),
    "shadow-only",
  );
  denied(() => fs.readFileSync(config.workspace + "/escape/secret", "utf8"));
  denied(() => fs.writeFileSync(config.workspace + "/escape/secret", "bad"));
  denied(() => fs.accessSync("/mnt/c/Windows/System32/cmd.exe"));
  assert.equal(process.env.MXC_PROBE_HOST_SECRET, undefined);
  assert.equal(process.env.HOME, config.home);
  assert.equal(process.cwd(), config.workspace);
  for (const peer of config.peers || []) {
    denied(() => fs.readFileSync(peer + "/peer-marker", "utf8"));
    denied(() => fs.writeFileSync(peer + "/peer-marker", "bad"));
  }

  fs.writeFileSync(config.workspace + "/result", "written");
  fs.writeFileSync(config.home + "/home-file", "private-home");
  fs.writeFileSync(process.env.TMPDIR + "/temp-file", "private-temp");
  process.stdout.write("FILESYSTEM_OK\n");
}

async function workers() {
  const message = await new Promise((resolve, reject) => {
    const worker = new Worker(
      'require("node:worker_threads").parentPort.postMessage("WORKER_OK")',
      { eval: true },
    );
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  assert.equal(message, "WORKER_OK");
  const child = spawnSync(
    process.execPath,
    ["-e", 'process.stdout.write("CHILD_OK")'],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "CHILD_OK");
  process.stdout.write("WORKERS_OK\n");
}

async function network() {
  const results = {};
  for (const target of config.targets) {
    results[target.name] = await connect(target.options);
    assert.notEqual(results[target.name], "connected", target.name);
  }

  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(
      await connect({ host: "127.0.0.1", port: server.address().port }),
      "connected",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  process.stdout.write(
    JSON.stringify({ results, netns: fs.readlinkSync("/proc/self/ns/net") }) +
      "\n",
  );
}

async function main() {
  switch (action) {
    case "filesystem":
      await filesystem();
      break;
    case "workers":
      await workers();
      break;
    case "network":
      await network();
      break;
    case "echo": {
      const lines = createInterface({ input: process.stdin });
      process.stderr.write("STDERR_OK\n");
      for await (const line of lines) {
        process.stdout.write(`ECHO:${line}\n`);
      }

      break;
    }

    case "heartbeat":
      fs.appendFileSync(config.workspace + "/heartbeat", ".");
      setInterval(
        () => fs.appendFileSync(config.workspace + "/heartbeat", "."),
        100,
      );
      break;
    case "tree": {
      const child = spawn(
        process.execPath,
        [process.argv[1], "heartbeat", token, encoded],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.on("error", (error) => {
        throw error;
      });
      process.stdout.write("TREE_READY\n");
      setInterval(() => {}, 1000);
      break;
    }

    case "read":
      process.stdout.write(fs.readFileSync(config.target, "utf8"));
      break;
    case "socket":
      process.stdout.write((await connect({ path: config.socket })) + "\n");
      break;
    default:
      throw new Error(`Unknown fixture action: ${action}`);
  }
}

await main();
