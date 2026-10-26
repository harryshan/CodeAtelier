/**
 * 正式 Linux backend + LocalOverlayService + Store + 候选验证器的真实 WSL 验收。
 * 1. 注入同 namespace 的正式挂载控制器，以真实 SQLite 绑定两个隔离 Local 会话。
 * 2. 两个 MXC Runtime 并行编辑；Service 绑定明确选集并在排空后调用 backend/Publisher 收尾。
 * 3. 每批候选由 LinuxCandidateValidator 新建视图，真实 Sandbox 验证合并源码，再正常刷新。
 * 4. 续轮检查合并源码及保留产物；另制造外部重叠修改，确认 rejected/ready 和私有结果保留。
 * 固定命令代替模型，未开放 Engine/HTTP/UI；仅独占夹具，报告和 trace 保留，不运行 Evaluation。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { LinuxOverlayController } from "../../src/local-overlays/linux-controller.ts";
import { LinuxLocalBackend } from "../../src/local-overlays/linux-backend.ts";
import { LinuxCandidateValidator } from "../../src/local-overlays/linux-candidate.ts";
import { LocalOverlayService } from "../../src/local-overlays/service.ts";
import { Store } from "../../src/sessions/store.ts";
import { TraceRecorder } from "../../src/tracing/recorder.ts";
import { TraceArchive } from "../../src/tracing/archive.ts";
import { MxcSandboxRuntime } from "../../src/sandbox/mxc-runtime.ts";
import { runCandidateCommands } from "../../src/local-overlays/command-runtime.ts";

const [root, sdkEntry, bundleDirectory] = process.argv.slice(2);
const source = path.join(root, "source");
await mkdir(source);
await writeFile(path.join(source, "module.py"), "a = 1\nb = 2\n");
await mkdir(path.join(source, ".git"));
const data = path.join(root, "data");
const storage = path.join(data, "local-overlays");
const log = pino({ enabled: false });
const traces = new TraceRecorder();
const archive = new TraceArchive(data, log);
const controller = new LinuxOverlayController(
  process.env.CODEATELIER_OVERLAY_SOCKET,
  log,
  traces,
  archive,
);
const views = path.join(root, "views");
const backend = new LinuxLocalBackend(storage, controller, log, views);
const service = new LocalOverlayService(data, log, backend);
const store = new Store(path.join(data, "history.sqlite"), { inline: true });
const validator = new LinuxCandidateValidator(storage, controller, log, views);
const sdk = await import(pathToFileURL(sdkEntry).href);
const runtime = new MxcSandboxRuntime({
  platform: "linux",
  dataDirectory: data,
  bundleDirectory,
  nodeExecutable: process.execPath,
  traces,
  log,
  loadSdk: async () => sdk,
});
const signal = () => AbortSignal.timeout(60000);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const report = {
  passed: false,
  parallel: false,
  published: [],
  candidates: 0,
  resumed: false,
  conflictRetained: false,
};

async function execute(workspace, python) {
  const taskId = randomUUID();
  traces.startTask(taskId, taskId);
  const result = await runCandidateCommands({
    launcher: { launch: (value) => runtime.launchTask(value) },
    traces,
    log,
    sessionId: taskId,
    taskId,
    workspace,
    commands: [`python3 -B -c ${quote(python)}`],
    signal: signal(),
    emit: async () => {},
  });
  assert.deepEqual(result, {
    drained: true,
    sandboxApplied: true,
    exitCode: 0,
  });
  traces.finishTask(taskId, "ok");
  await archive.write(taskId, taskId, traces.exportTask(taskId));
  traces.discardTask(taskId);
  return result;
}

async function create() {
  return service.create({ id: randomUUID(), source }, async (workspace) =>
    store.create(workspace, "Linux backend fixture"),
  );
}

try {
  const sessions = [await create(), await create()];
  const tasks = [randomUUID(), randomUUID()];
  const leases = await Promise.all(
    sessions.map((session, index) =>
      service.begin(session.workspace, session.id, tasks[index], signal()),
    ),
  );
  const intervals = await Promise.all(
    sessions.map(async (session, index) => {
      const content = index === 0 ? "a = 10\nb = 2\n" : "a = 1\nb = 20\n";
      await execute(
        session.workspace,
        `import pathlib,time,json; p=pathlib.Path('module.py'); assert p.read_text()=='a = 1\\nb = 2\\n'; start=time.time(); time.sleep(0.4); p.write_text(${JSON.stringify(content)}); pathlib.Path('artifact').write_text('private'); pathlib.Path('interval.json').write_text(json.dumps([start,time.time()]))`,
      );
      return JSON.parse(
        await readFile(path.join(session.workspace, "interval.json"), "utf8"),
      );
    }),
  );
  assert.ok(
    Math.max(...intervals.map((value) => value[0])) <
      Math.min(...intervals.map((value) => value[1])),
  );
  report.parallel = true;
  for (const [index, session] of sessions.entries()) {
    await service.select(session.workspace, session.id, tasks[index], {
      paths: ["module.py"],
      validate: (files, current) =>
        validator.validate(
          source,
          files,
          async (workspace) => {
            report.candidates++;
            return execute(
              workspace,
              `import pathlib,runpy; assert not pathlib.Path('artifact').exists(); v=runpy.run_path('module.py'); assert v['a']+v['b']==${index === 0 ? 12 : 30}; pathlib.Path('candidate-artifact').write_text('private')`,
            );
          },
          current ?? signal(),
        ),
    });
    const result = await leases[index].finish("completed", true);
    assert.equal(result.phase, "ready");
    assert.equal(result.publication.state, "published");
    report.published.push(result.publication.batchId);
  }
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    "a = 10\nb = 20\n",
  );
  const resumed = await service.begin(
    sessions[1].workspace,
    sessions[1].id,
    randomUUID(),
    signal(),
  );
  await execute(
    sessions[1].workspace,
    "import pathlib; assert pathlib.Path('module.py').read_text()=='a = 10\\nb = 20\\n'; assert pathlib.Path('artifact').read_text()=='private'",
  );
  assert.equal((await resumed.finish("completed", true)).phase, "ready");
  report.resumed = true;
  const conflict = await create();
  const conflictTask = randomUUID();
  const conflictLease = await service.begin(
    conflict.workspace,
    conflict.id,
    conflictTask,
    signal(),
  );
  await execute(
    conflict.workspace,
    "import pathlib; p=pathlib.Path('module.py'); assert p.read_text()=='a = 10\\nb = 20\\n'; p.write_text('a = 99\\nb = 20\\n')",
  );
  await writeFile(path.join(source, "module.py"), "a = 40\nb = 20\n");
  await service.select(conflict.workspace, conflict.id, conflictTask, {
    paths: ["module.py"],
    validate: async () => {
      throw new Error("Conflict must precede candidate");
    },
  });
  const rejected = await conflictLease.finish("completed", true);
  assert.equal(rejected.phase, "ready");
  assert.equal(rejected.publication.state, "rejected");
  assert.equal(rejected.publication.reason, "TEXT_CONFLICT");
  assert.equal(
    await readFile(
      path.join(storage, rejected.id, "upper", "module.py"),
      "utf8",
    ),
    "a = 99\nb = 20\n",
  );
  assert.equal(
    await readFile(path.join(source, "module.py"), "utf8"),
    "a = 40\nb = 20\n",
  );
  assert.deepEqual((await readdir(source)).sort(), [".git", "module.py"]);
  assert.deepEqual(await readdir(path.join(data, "mxc", "active")), []);
  report.conflictRetained = true;
  await service.close();
  report.passed = true;
} finally {
  await store.close();
  await writeFile(
    path.join(root, "backend-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
