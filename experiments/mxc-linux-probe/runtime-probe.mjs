/**
 * 手动验证 native Linux 目标的真实 AgentRuntimeService ↔ Broker gateway/session 通信，仅在 Linux 原生目录运行。
 * 1. launch 为每次测试创建 workspace/HOME/tmp/private 假夹具，用 MXC Bubblewrap 启动固定 bundle；私有 stdio 交付首帧。
 * 2. 正常路径执行真实 read_file Worker、edit_files、run_command，校验模型/session 往返及安全 trace；四任务另做并发对照。
 * 3. 错误 nonce/首帧、模型取消、命令取消/断连/Runtime kill 分别验证失败、不重放、终态及心跳停止。
 * 4. 所有测试独立捕获结果并写本地报告，finally 收回 MXC handle；不触发真实模型、宿主能力、Evaluation 或产品后端。
 * Broker 使用生产协议/gateway，但 session 是内存 fixture；WSL 只是 Linux 内核侧运行环境，不测试 DrvFS，不声称裸机验收。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "@microsoft/mxc-sdk/v1";
import { createRuntimeProbe } from "./runtime-bundle/broker-fixture.mjs";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
const app = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(app, "runtime-bundle");
const base = path.join(app, "runtime-runs");
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, "run-"));
const hostNet = fs.readlinkSync("/proc/self/ns/net");
const results = [];
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, description) {
  const deadline = Date.now() + 7000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${description}`);
    }

    await delay(30);
  }
}

async function launch(label, mode = "normal") {
  const dir = path.join(root, label);
  const workspace = path.join(dir, "workspace");
  for (const child of ["workspace", "home", "tmp", "private"]) {
    fs.mkdirSync(path.join(dir, child), { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(path.join(dir, "private", "secret"), "fake-broker-private");
  fs.writeFileSync(
    path.join(workspace, "input.txt"),
    `marker-${label}\n` + "x".repeat(150000),
  );
  const command = [
    process.execPath,
    path.join(bundle, "runtime-workload.mjs"),
    mode === "normal" ? "once" : "loop",
    path.join(dir, "private", "secret"),
  ]
    .map(quote)
    .join(" ");
  const child = await spawn({
    containment: { type: "bubblewrap" },
    command: [process.execPath, path.join(bundle, "agent-runtime.mjs")]
      .map(quote)
      .join(" "),
    workingDirectory: workspace,
    filesystem: {
      readonlyPaths: [path.dirname(path.dirname(process.execPath)), bundle],
      readwritePaths: [
        workspace,
        path.join(dir, "home"),
        path.join(dir, "tmp"),
      ],
    },
    environment: {
      HOME: path.join(dir, "home"),
      TMPDIR: path.join(dir, "tmp"),
      PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
    },
    inheritDefaultEnvironment: false,
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
    timeoutMs: 20000,
  });
  // 必须先取得三个流的所有权，再 wait；stdout 不允许日志污染 IPC。
  const input = child.standardOutput;
  const output = child.standardInput;
  let stderr = "";
  child.standardError.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-12000);
  });
  const exited = child.wait();
  void exited.catch(() => undefined);
  const calls =
    mode === "normal"
      ? [
          {
            name: "read_file",
            arguments: { path: "input.txt", startLine: 1, endLine: 1 },
          },
          {
            name: "edit_files",
            arguments: {
              files: [
                {
                  path: "created.txt",
                  create: true,
                  content: `created-${label}`,
                },
              ],
            },
          },
          { name: "run_command", arguments: { command } },
        ]
      : [{ name: "run_command", arguments: { command } }];
  const probe = createRuntimeProbe(
    { input, output },
    { workspace, calls, blocked: mode === "model" },
  );

  return {
    ...probe,
    workspace,
    child,
    output,
    exited,
    async close() {
      probe.broker.peer.end();
      try {
        child.kill();
      } catch {
        /* 退出过的句柄不重复执行工作负载。 */
      }

      try {
        await exited;
      } finally {
        child.dispose();
        const status = probe.state.completion?.status;
        probe.traces.finishTask(
          probe.identity.taskId,
          status === "completed"
            ? "ok"
            : status === "cancelled"
              ? "cancelled"
              : "unknown",
        );
        fs.writeFileSync(path.join(dir, "stderr.log"), stderr);
        fs.writeFileSync(
          path.join(dir, "trace.json"),
          JSON.stringify(probe.traces.exportTask(probe.identity.taskId)),
        );
      }
    },
  };
}

async function check(name, operation) {
  const start = Date.now();
  try {
    const evidence = await operation();
    results.push({
      name,
      status: "PASS",
      durationMs: Date.now() - start,
      evidence,
    });
    process.stdout.write(`INFO mxc-runtime PASS ${name}\n`);
  } catch (error) {
    results.push({
      name,
      status: "FAIL",
      durationMs: Date.now() - start,
      error: String(error),
    });
    process.stdout.write(`WARN mxc-runtime FAIL ${name}: ${String(error)}\n`);
  }
}

async function normal(label) {
  const probe = await launch(label);
  try {
    probe.sendDescriptor();
    const result = await probe.start(AbortSignal.timeout(15000));
    assert.deepEqual(result, { status: "completed" });
    await probe.broker.waitForStop(AbortSignal.timeout(2000));
    assert.equal(probe.state.completion.status, "completed");
    assert.equal(probe.state.modelCalls, 2);
    const returned = JSON.stringify(probe.state.modelInputs[1]);
    assert.ok(returned.includes(`marker-${label}`));
    assert.ok(returned.includes("IPC_TOOL_OK"));
    assert.ok(returned.includes("IPC_TOOL_STDERR"));
    assert.ok(!returned.includes(hostNet));
    assert.equal(
      fs.readFileSync(path.join(probe.workspace, "created.txt"), "utf8"),
      `created-${label}`,
    );
    assert.equal(
      fs.readFileSync(path.join(probe.workspace, "command.txt"), "utf8"),
      "command-executed-in-runtime",
    );
    const trace = probe.traces.exportTask(probe.identity.taskId);
    assert.ok(JSON.stringify(trace).includes("read_file.worker"));
    assert.ok(!JSON.stringify(trace).includes("fake-broker-private"));
    assert.ok(probe.state.events.some((event) => event.type === "assistant"));
    assert.ok(
      probe.state.events.some(
        (event) =>
          event.type === "delta" && event.data.text === "IPC fixture complete",
      ),
    );
    probe.broker.peer.end();
    const exit = await probe.exited;
    assert.equal(exit.exitCode, 0);

    return {
      modelCalls: probe.state.modelCalls,
      events: probe.state.events.length,
      exit,
    };
  } finally {
    await probe.close();
  }
}

await check("real-runtime-tools-model-session-trace", () => normal("normal"));
await check("four-runtime-private-channels", () =>
  Promise.all([0, 1, 2, 3].map((i) => normal(`parallel-${i}`))),
);
await check("wrong-nonce-before-work", async () => {
  const probe = await launch("wrong-nonce");
  try {
    probe.sendDescriptor(true);
    await assert.rejects(probe.start(AbortSignal.timeout(5000)), /身份不匹配/);
    assert.equal(probe.state.modelCalls, 0);
    const exit = await probe.exited;
    assert.notEqual(exit.exitCode, 0);

    return exit;
  } finally {
    await probe.close();
  }
});
await check("malformed-startup-before-work", async () => {
  const probe = await launch("bad-frame");
  try {
    probe.output.write(Buffer.alloc(4, 255));
    probe.output.end();
    const exit = await probe.exited;
    assert.notEqual(exit.exitCode, 0);
    assert.equal(probe.state.modelCalls, 0);

    return exit;
  } finally {
    await probe.close();
  }
});
await check("model-cancellation", async () => {
  const probe = await launch("model-cancel", "model");
  try {
    probe.sendDescriptor();
    const controller = new AbortController();
    const result = probe
      .start(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
      .catch((error) => error);
    await Promise.race([
      probe.started,
      result.then(() => {
        throw new Error("Runtime exited before model started");
      }),
    ]);
    controller.abort(new Error("fixture cancellation"));
    await probe.broker.waitForStop(AbortSignal.timeout(5000));
    assert.ok((await result) instanceof Error);
    assert.equal(probe.state.modelAborted, true);
    assert.equal(probe.state.modelCalls, 1);
    assert.equal(probe.state.completion.status, "cancelled");

    return { status: probe.state.completion.status, modelAborted: true };
  } finally {
    await probe.close();
  }
});
for (const mode of ["cancel", "disconnect", "kill"]) {
  await check(`command-${mode}-no-replay-cleanup`, async () => {
    const probe = await launch(`command-${mode}`, "command");
    try {
      probe.sendDescriptor();
      const controller = new AbortController();
      const result = probe.start(controller.signal).catch((error) => error);
      const files = ["beat-parent", "beat-child"].map((name) =>
        path.join(probe.workspace, name),
      );
      await until(
        () => files.every((file) => fs.existsSync(file)),
        "command descendants ready",
      );
      if (mode === "cancel") {
        controller.abort(new Error("fixture cancellation"));
        await probe.broker.waitForStop(AbortSignal.timeout(5000));
        assert.equal(probe.state.completion.status, "cancelled");
        probe.broker.peer.end();
      } else if (mode === "disconnect") {
        probe.broker.peer.end();
      } else {
        probe.child.kill();
      }

      assert.ok((await result) instanceof Error);
      await probe.exited;
      await delay(200);
      const before = files.map((file) => fs.readFileSync(file, "utf8"));
      await delay(400);
      assert.deepEqual(
        files.map((file) => fs.readFileSync(file, "utf8")),
        before,
      );
      assert.equal(probe.state.modelCalls, 1);
      if (mode !== "cancel") {
        assert.notEqual(probe.state.completion?.status, "completed");
      }

      return {
        modelCalls: 1,
        heartbeatStopped: true,
        completion: probe.state.completion?.status ?? "unknown",
      };
    } finally {
      await probe.close();
    }
  });
}

const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  uid: process.getuid(),
  results,
};
fs.writeFileSync(
  path.join(root, "report.json"),
  JSON.stringify(report, null, 2),
);
const failed = results.filter((item) => item.status !== "PASS").length;
process.stdout.write(
  `INFO mxc-runtime END passed=${results.length - failed} failed=${failed} report=${path.join(root, "report.json")}\n`,
);
process.exitCode = failed ? 1 : 0;
