/**
 * 显式 Linux namespace 启动器 → 正式 Broker 控制 IPC → 实际 MXC 的手动验收。
 * 1. 在操作者给定的独占 ext4 根建立合成来源，核对 Node 全部 capabilities 为零。
 * 2. 正式客户端创建两视图；真实 Runtime 并行写入各 upper，来源/Git/socket 保持不可写或不可见。
 * 3. Runtime 确认排空后 seal、正常关闭并重新打开；私有修改保留，最后清理所有挂载。
 * 4. 报告及 tracing 留在夹具；不启动模型、真实用户服务或 Evaluation，不改变产品平台门禁。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { LinuxOverlayController } from "../../src/local-overlays/linux-controller.ts";
import { TraceRecorder } from "../../src/tracing/recorder.ts";
import { TraceArchive } from "../../src/tracing/archive.ts";
import { MxcSandboxRuntime } from "../../src/sandbox/mxc-runtime.ts";
import { runCandidateCommands } from "../../src/local-overlays/command-runtime.ts";

const [root, sdkEntry, bundleDirectory] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
const status = await readFile("/proc/self/status", "utf8");
for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
  assert.match(status, new RegExp(`^${field}:\\s+0+$`, "m"));
}
const source = path.join(root, "source");
await mkdir(source);
await writeFile(path.join(source, "module.py"), "original\n");
await mkdir(path.join(source, ".git"));
await writeFile(path.join(source, ".git", "sentinel"), "hidden");
const log = pino({ enabled: false });
const traces = new TraceRecorder();
const archive = new TraceArchive(root, log);
const controller = new LinuxOverlayController(
  process.env.CODEATELIER_OVERLAY_SOCKET,
  log,
  traces,
  archive,
);
const sdk = await import(pathToFileURL(sdkEntry).href);
const broker = path.join(root, "broker");
const runtime = new MxcSandboxRuntime({
  platform: "linux",
  dataDirectory: broker,
  bundleDirectory,
  nodeExecutable: process.execPath,
  traces,
  log,
  loadSdk: async () => sdk,
});
const ids = [randomUUID(), randomUUID()];
const views = [];
const report = {
  passed: false,
  capabilities: "none",
  ready: [],
  runs: [],
  reopened: false,
};
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
for (const id of ids) {
  const view = await controller.open(id, source, true);
  views.push(view);
  report.ready.push(view.ready);
}
await Promise.all(
  views.map(async (view, index) => {
    const taskId = randomUUID();
    traces.startTask(taskId, ids[index]);
    const code = `import pathlib,time,json,os
p=pathlib.Path('module.py')
assert p.read_text() == 'original\\n'
assert not pathlib.Path('.git/sentinel').exists()
assert not pathlib.Path(${JSON.stringify(process.env.CODEATELIER_OVERLAY_SOCKET)}).exists()
try:
 pathlib.Path(${JSON.stringify(path.join(source, "module.py"))}).write_text('forbidden')
except OSError:
 pass
else:
 raise AssertionError('source writable')
begin=time.time_ns()
time.sleep(0.4)
p.write_text('private-${index}\\n')
pathlib.Path('interval.json').write_text(json.dumps([begin,time.time_ns()]))`;
    const result = await runCandidateCommands({
      launcher: { launch: (value) => runtime.launchTask(value) },
      traces,
      log,
      sessionId: ids[index],
      taskId,
      workspace: view.workspace,
      commands: [`python3 -B -c ${quote(code)}`],
      signal: AbortSignal.timeout(60000),
      emit: async () => {},
    });
    assert.deepEqual(result, {
      drained: true,
      sandboxApplied: true,
      exitCode: 0,
    });
    traces.finishTask(taskId, "ok");
    await archive.write(ids[index], taskId, traces.exportTask(taskId));
    traces.discardTask(taskId);
    report.runs[index] = {
      ...result,
      interval: JSON.parse(
        await readFile(path.join(view.workspace, "interval.json"), "utf8"),
      ),
    };
  }),
);
assert.ok(
  Math.max(...report.runs.map((run) => run.interval[0])) <
    Math.min(...report.runs.map((run) => run.interval[1])),
);
for (const [index, id] of ids.entries()) {
  const sealId = await controller.seal(id);
  const manifest = JSON.parse(
    await readFile(path.join(views[index].control, sealId + ".json"), "utf8"),
  );
  assert.equal(manifest.source.root, source);
  await controller.close(id);
  const reopened = await controller.open(id, source, false);
  assert.equal(
    await readFile(path.join(reopened.workspace, "module.py"), "utf8"),
    `private-${index}\n`,
  );
  await controller.close(id);
}
assert.equal(
  await readFile(path.join(source, "module.py"), "utf8"),
  "original\n",
);
assert.deepEqual(await readdir(path.join(broker, "mxc", "active")), []);
report.reopened = true;
report.passed = true;
await writeFile(
  path.join(root, "controller-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
