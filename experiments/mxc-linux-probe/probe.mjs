/**
 * 手动执行 MXC 1.0.0/Bubblewrap 的真实 Linux 探针，不接入 CodeAtelier 产品或默认测试。
 * 由独立实验目录的 Node 启动，依赖同目录安装的 MXC；MXC_PROBE_BASE 可指定夹具所在文件系统。
 * 1. 创建随机、仅含虚构数据的夹具；launch 固定最小策略并收集有界输出，check 记录每项证据。
 * 2. 验证 discovery、读写/环境/链接、Node 子进程与 Worker、双向 stdio、网络及四实例并行。
 * 3. 以 /proc 精确 argv 标记和心跳验证 kill/timeout/控制进程崩溃的后代终止；失败只清理本实验进程。
 * 4. 将硬链接和可写路径下 UNIX socket 作为明确的边界特征，而非宣称完全隔离；最后保存报告。
 * 全部写入限于新建夹具；不读取宿主真实密钥，不修改权限/内核配置，不运行模型或 Evaluation。
 * 本独立实验不接产品 tracing；报告包含逐项耗时/状态，产品集成需另接生命周期 tracing。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { getPlatformSupport, spawn } from "@microsoft/mxc-sdk/v1";
import { spawn as hostSpawn, spawnSync } from "node:child_process";
import { once } from "node:events";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0, "Run as a non-root Linux user");
const app = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.MXC_PROBE_BASE || path.join(app, "runs");
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, "run-"));
const results = [];
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  kernel: os.release(),
  node: process.version,
  sdk: JSON.parse(
    fs.readFileSync(
      path.join(app, "node_modules/@microsoft/mxc-sdk/package.json"),
      "utf8",
    ),
  ).version,
  nativeSha256: createHash("sha256")
    .update(
      fs.readFileSync(
        path.join(
          app,
          `node_modules/@microsoft/mxc-sdk/bin/${process.arch}/libmxc_ffi.so`,
        ),
      ),
    )
    .digest("hex"),
  bubblewrap: spawnSync("bwrap", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  }).stdout?.trim(),
  uid: process.getuid(),
  root,
  results,
};
process.env.MXC_PROBE_HOST_SECRET = "fixture-not-a-real-secret";

function log(level, message) {
  process.stdout.write(
    `${new Date().toISOString()} ${level} mxc-probe ${message}\n`,
  );
}

function fixture(name) {
  const directory = path.join(root, name);
  const config = { directory };
  for (const key of ["workspace", "readonly", "private", "home", "temp"]) {
    config[key] = path.join(directory, key);
    fs.mkdirSync(config[key], { recursive: true });
  }

  fs.mkdirSync(config.workspace + "/denied");
  fs.writeFileSync(config.workspace + "/peer-marker", name);
  fs.writeFileSync(config.readonly + "/input", "readonly");
  fs.writeFileSync(config.private + "/secret", "fixture-secret");
  fs.writeFileSync(config.workspace + "/denied/secret", "denied-secret");
  fs.symlinkSync(config.private, config.workspace + "/escape");
  fs.copyFileSync(
    path.join(app, "workload.mjs"),
    config.workspace + "/workload.mjs",
  );

  return config;
}

function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function launch(
  config,
  action,
  { timeoutMs = 15000, token = randomUUID() } = {},
) {
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
  const command = [
    process.execPath,
    config.workspace + "/workload.mjs",
    action,
    token,
    encoded,
  ]
    .map(quote)
    .join(" ");
  const child = await spawn({
    containment: { type: "bubblewrap" },
    command,
    workingDirectory: config.workspace,
    filesystem: {
      readonlyPaths: [
        path.dirname(path.dirname(process.execPath)),
        config.readonly,
      ],
      readwritePaths: [config.workspace, config.home, config.temp],
      deniedPaths: [config.workspace + "/denied"],
    },
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
    environment: {
      PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
      HOME: config.home,
      TMPDIR: config.temp,
      LANG: "C.UTF-8",
    },
    inheritDefaultEnvironment: false,
    timeoutMs,
  });
  let stdout = "";
  let stderr = "";
  child.standardOutput.on("data", (data) => {
    stdout = (stdout + data).slice(-65536);
  });
  child.standardError.on("data", (data) => {
    stderr = (stderr + data).slice(-65536);
  });
  // wait() 会关闭尚未取得的 stdin；交互调用必须先显式取得其所有权。
  const input = child.standardInput;
  if (action !== "echo") {
    input.end();
  }

  const completion = Promise.all([
    child.wait(),
    finished(child.standardOutput),
    finished(child.standardError),
  ]).then(([status]) => ({
    ...status,
    stdout,
    stderr,
    warnings: child.warnings,
  }));
  // 先挂失败处理，避免交互等待期间把原生失败变成未处理 rejection；调用者仍会 await 原 promise。
  completion.catch(() => {});

  return { child, input, completion, token, output: () => stdout };
}

async function execute(config, action, options) {
  const handle = await launch(config, action, options);
  try {
    const result = await handle.completion;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.timedOut, false);

    return result;
  } finally {
    handle.child.dispose();
  }
}

async function until(predicate, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await delay(50);
  }

  throw new Error(`Timed out: ${description}`);
}

async function check(name, operation) {
  const started = Date.now();
  try {
    const evidence = await operation();
    results.push({
      name,
      status: "PASS",
      durationMs: Date.now() - started,
      evidence,
    });
    log("INFO", `PASS ${name} durationMs=${Date.now() - started}`);
  } catch (error) {
    results.push({
      name,
      status: "FAIL",
      durationMs: Date.now() - started,
      error: String(error),
    });
    log("WARN", `FAIL ${name}: ${error}`);
  }
}

function liveProcesses(token) {
  const matches = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    try {
      const argv = fs
        .readFileSync(`/proc/${entry}/cmdline`, "utf8")
        .split("\0");
      if (argv.includes(token)) {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z") {
          matches.push(Number(entry));
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") {
        throw error;
      }
    }
  }

  return matches;
}

async function treeCheck(mode) {
  const config = fixture(mode);
  const handle = await launch(config, "tree", {
    timeoutMs: mode === "timeout" ? 4000 : 20000,
  });
  try {
    await until(
      () =>
        handle.output().includes("TREE_READY") &&
        liveProcesses(handle.token).length >= 2,
      "tree ready",
    );
    await until(
      () => fs.existsSync(config.workspace + "/heartbeat"),
      "heartbeat starts",
    );
    const before = liveProcesses(handle.token).length;
    if (mode === "cancel") {
      handle.child.kill();
    }

    const status = await handle.completion;
    assert.equal(status.timedOut, mode === "timeout");
    await until(
      () => liveProcesses(handle.token).length === 0,
      "all marked descendants exit",
    );
    const size = fs.statSync(config.workspace + "/heartbeat").size;
    await delay(500);
    assert.equal(fs.statSync(config.workspace + "/heartbeat").size, size);

    return {
      before,
      after: 0,
      exitCode: status.exitCode,
      timedOut: status.timedOut,
    };
  } finally {
    handle.child.kill();
    await handle.completion.catch(() => {});
    handle.child.dispose();
    // 仅清理仍带本次随机 argv 标记的活进程；不按程序名或模糊进程组杀其它任务。
    for (const pid of liveProcesses(handle.token)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  }
}

async function connect(options) {
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

async function listen(options) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, resolve);
  });

  return server;
}

log(
  "INFO",
  `START uid=${process.getuid()} node=${process.version} root=${root}`,
);

await check("discovery", async () => {
  report.discovery = getPlatformSupport();
  assert.equal(
    report.discovery.availableMethods.includes("bubblewrap"),
    true,
    report.discovery.reason,
  );

  return report.discovery;
});

await check("filesystem-environment-symlink", async () => {
  const config = fixture("filesystem");
  const result = await execute(config, "filesystem");
  assert.match(result.stdout, /FILESYSTEM_OK/);
  assert.equal(
    fs.readFileSync(config.workspace + "/result", "utf8"),
    "written",
  );
  assert.equal(fs.readFileSync(config.readonly + "/input", "utf8"), "readonly");
  assert.equal(
    fs.readFileSync(config.private + "/secret", "utf8"),
    "fixture-secret",
  );
  assert.equal(
    fs.readFileSync(config.workspace + "/denied/secret", "utf8"),
    "denied-secret",
  );
  assert.equal(fs.existsSync(config.private + "/outside"), false);

  return {
    readonlyUnchanged: true,
    privateUnchanged: true,
    deniedUnchanged: true,
  };
});

await check("unsandboxed-negative-control", async () => {
  const config = fixture("negative-control");
  const result = spawnSync(
    process.execPath,
    [
      config.workspace + "/workload.mjs",
      "filesystem",
      randomUUID(),
      Buffer.from(JSON.stringify(config)).toString("base64"),
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing expected exception/);
  assert.equal(fs.readFileSync(config.readonly + "/input", "utf8"), "bad");

  return "Without MXC the readonly write succeeds and the same assertion fails.";
});

await check("node-worker-and-child", async () => {
  assert.match(
    (await execute(fixture("workers"), "workers")).stdout,
    /WORKERS_OK/,
  );
});

await check("stdio-two-rounds", async () => {
  const handle = await launch(fixture("stdio"), "echo");
  try {
    handle.input.write("first\n");
    await until(
      () => handle.output().includes("ECHO:first"),
      "first response while process alive",
    );
    handle.input.write("second\n");
    await until(
      () => handle.output().includes("ECHO:second"),
      "second response while process alive",
    );
    handle.input.end();
    const result = await handle.completion;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /STDERR_OK/);
  } finally {
    handle.child.kill();
    await handle.completion.catch(() => {});
    handle.child.dispose();
  }
});

await check("network-private-namespace", async () => {
  const servers = [];
  try {
    const targets = [];
    for (const host of ["127.0.0.1", "::1"]) {
      const server = await listen({ host, port: 0 });
      servers.push(server);
      const options = { host, port: server.address().port };
      assert.equal(
        await connect(options),
        "connected",
        "host positive control",
      );
      targets.push({ name: host, options });
    }

    const externalControl = await connect({ host: "1.1.1.1", port: 443 });
    targets.push({
      name: "public-ipv4",
      options: { host: "1.1.1.1", port: 443 },
    });
    const config = { ...fixture("network"), targets };
    const result = JSON.parse((await execute(config, "network")).stdout);
    assert.notEqual(result.netns, fs.readlinkSync("/proc/self/ns/net"));

    return {
      ...result,
      externalControl,
      externalVerified: externalControl === "connected",
    };
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
});

await check("four-concurrent-workspaces", async () => {
  const configs = Array.from({ length: 4 }, (_, index) =>
    fixture(`parallel-${index}`),
  );
  for (const config of configs) {
    config.peers = configs
      .filter((peer) => peer !== config)
      .map((peer) => peer.workspace);
  }

  const outcomes = await Promise.allSettled(
    configs.map((config) => execute(config, "filesystem")),
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "fulfilled", String(outcome.reason));
  }

  for (const config of configs) {
    assert.equal(
      fs.readFileSync(config.workspace + "/result", "utf8"),
      "written",
    );
  }
});

await check("cancel-detached-descendant", () => treeCheck("cancel"));
await check("timeout-detached-descendant", () => treeCheck("timeout"));

await check("controller-crash-detached-descendant", async () => {
  const config = fixture("crash");
  const token = randomUUID();
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
  const controller = hostSpawn(
    process.execPath,
    [path.join(app, "controller.mjs"), encoded, token],
    {
      env: {
        HOME: config.home,
        PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(controller, "exit");
  let output = "";
  controller.stdout.on("data", (data) => {
    output = (output + data).slice(-4096);
  });
  controller.stderr.resume();
  try {
    await until(
      () => output.includes("TREE_READY") && liveProcesses(token).length >= 3,
      "controller and tree ready",
    );
    await until(
      () => fs.existsSync(config.workspace + "/heartbeat"),
      "crash heartbeat starts",
    );
    controller.kill("SIGKILL");
    await exited;
    await until(
      () => liveProcesses(token).length === 0,
      "controller death tears down sandbox",
    );
    const size = fs.statSync(config.workspace + "/heartbeat").size;
    await delay(500);
    assert.equal(fs.statSync(config.workspace + "/heartbeat").size, size);

    return { after: 0, heartbeatStopped: true };
  } finally {
    controller.kill("SIGKILL");
    await exited;
    for (const pid of liveProcesses(token)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  }
});

await check("characterize-hardlink-alias", async () => {
  const config = fixture("hardlink");
  config.target = config.workspace + "/alias";
  fs.linkSync(config.private + "/secret", config.target);
  const result = await execute(config, "read");
  assert.equal(result.stdout, "fixture-secret");

  return "A pre-existing hardlink in an authorized directory exposes that inode; path grants are not provenance isolation.";
});

await check("characterize-unix-socket-in-write-root", async () => {
  const config = fixture("unix-socket");
  config.socket = config.workspace + "/fixture.sock";
  const server = await listen({ path: config.socket });
  try {
    assert.equal(await connect({ path: config.socket }), "connected");
    const result = await execute(config, "socket");
    assert.equal(result.stdout.trim(), "connected");

    return "Network deny does not block an AF_UNIX listener under a granted filesystem root.";
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await check("unix-socket-private-linux-temp", async () => {
  const config = fixture("native-temp-socket");
  // app 按实验约定位于 Linux 文件系统；即使工作区是 DrvFS，IPC/temp 也可单独投影。
  config.temp = fs.mkdtempSync(path.join(app, "socket-temp-"));
  config.socket = config.temp + "/fixture.sock";
  let server;
  try {
    server = await listen({ path: config.socket });
    assert.equal(await connect({ path: config.socket }), "connected");
    const result = await execute(config, "socket");
    assert.equal(result.stdout.trim(), "connected");

    return "An explicitly granted Linux temporary directory supports AF_UNIX even with a DrvFS workspace.";
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    fs.rmdirSync(config.temp);
  }
});

const failures = results.filter((result) => result.status === "FAIL");
fs.writeFileSync(
  path.join(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
log(
  "INFO",
  `END passed=${results.length - failures.length} failed=${failures.length} report=${root}/report.json`,
);
process.exitCode = failures.length ? 1 : 0;
