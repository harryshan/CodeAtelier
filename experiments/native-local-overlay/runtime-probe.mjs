/**
 * 在实验专属 mount namespace 中验证生产 MXC 启动器和候选命令 Runtime。
 * 1. 启动段校验普通 UID 与撤销后的 capabilities，接收明确的夹具/SDK/bundle 路径。
 * 2. execute 用真实 MxcSandboxRuntime、runCandidateCommands 和生产 tracing 执行
 *    固定合成命令；不调用模型服务，不授予来源或基线控制目录写权限。
 * 3. 两个 Runtime 并发写独立视图，断言原文/私有产物、来源写拒绝、隐藏 Git、
 *    Broker 假秘密和能力撤销，并确认正式 IPC 终态与持久启动标记清理。
 * 4. 报告与 trace 留在独占实验目录。异常不重放，不运行 Evaluation，不启动用户服务。
 * 通过 esbuild 打包当前生产代码；SDK 由操作者提供已安装的固定 1.0.0 Linux 入口。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { MxcSandboxRuntime } from "../../src/sandbox/mxc-runtime.ts";
import { runCandidateCommands } from "../../src/local-overlays/command-runtime.ts";
import { TraceRecorder } from "../../src/tracing/recorder.ts";

const [root, sdkEntry, bundleDirectory] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
assert.ok(
  [root, sdkEntry, bundleDirectory].every((value) => path.isAbsolute(value)),
);
const status = await readFile("/proc/self/status", "utf8");
for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
  assert.match(status, new RegExp(`^${field}:\\s+0+$`, "m"));
}
const sdk = await import(pathToFileURL(sdkEntry).href);
const dataDirectory = path.join(root, "broker");
await mkdir(dataDirectory);
const secret = path.join(dataDirectory, "fake-secret");
await writeFile(secret, "fixture-only");
const traces = new TraceRecorder();
const log = pino({ enabled: false });
const runtime = new MxcSandboxRuntime({
  platform: "linux",
  dataDirectory,
  bundleDirectory,
  nodeExecutable: process.execPath,
  traces,
  log,
  loadSdk: async () => sdk,
});
const report = {
  passed: false,
  uid: process.getuid(),
  capabilities: "none",
  runs: [],
};
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function execute(label) {
  const workspace = path.join(root, label, "view");
  const taskId = randomUUID();
  traces.startTask(taskId, label);
  const source = path.join(root, "source", "module.py");
  const text = label === "A" ? "a = 10\nb = 2\n" : "a = 1\nb = 20\n";
  const script = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const started = Date.now();
    assert.equal(fs.readFileSync('module.py', 'utf8'), 'a = 1\\nb = 2\\n');
    assert.equal(fs.existsSync('.git/sentinel'), false);
    assert.equal(fs.existsSync(${JSON.stringify(secret)}), false);
    assert.throws(() => fs.writeFileSync(${JSON.stringify(source)}, 'forbidden'));
    assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(root, label === "A" ? "B" : "A", "view", "module.py"))}, 'peer-forbidden'));
    assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^CapEff:\\s+0+$/m);
    fs.writeFileSync('module.py', ${JSON.stringify(text)});
    fs.writeFileSync('artifact-${label}', 'private');
    setTimeout(() => {
      fs.writeFileSync('interval.json', JSON.stringify([started, Date.now()]));
    }, 400);
  `;
  const events = [];
  try {
    const result = await runCandidateCommands({
      launcher: { launch: (input) => runtime.launchTask(input) },
      traces,
      log,
      sessionId: label,
      taskId,
      workspace,
      commands: [`node -e ${quote(script)}`],
      signal: AbortSignal.timeout(60000),
      emit: async (type, value) => {
        if (type === "execution_instance") {
          events.push(value);
        }
      },
    });
    assert.deepEqual(result, {
      drained: true,
      sandboxApplied: true,
      exitCode: 0,
    });
    assert.ok(
      events.some(
        (event) =>
          event.mode === "linux-bubblewrap" && event.state === "completed",
      ),
    );
    assert.equal(
      await readFile(path.join(workspace, "module.py"), "utf8"),
      text,
    );
    const interval = JSON.parse(
      await readFile(path.join(workspace, "interval.json"), "utf8"),
    );
    report.runs.push({ label, ...result, interval });
    traces.finishTask(taskId, "ok");
  } catch (error) {
    traces.finishTask(taskId, "error");
    throw error;
  } finally {
    await writeFile(
      path.join(root, `trace-${label}.json`),
      JSON.stringify(traces.exportTask(taskId)),
    );
  }
}

try {
  const outcomes = await Promise.allSettled([execute("A"), execute("B")]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
  }
  const [a, b] = report.runs;
  assert.ok(
    Math.max(a.interval[0], b.interval[0]) <
      Math.min(a.interval[1], b.interval[1]),
  );
  assert.equal(
    await readFile(path.join(root, "source", "module.py"), "utf8"),
    "a = 1\nb = 2\n",
  );
  assert.deepEqual(
    await readdir(path.join(dataDirectory, "mxc", "active")),
    [],
  );
  report.sourcePreserved = true;
  report.parallelCommands = true;
  report.activeRuntimeMarkers = 0;
  report.passed = true;
} finally {
  await writeFile(
    path.join(root, "runtime-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
