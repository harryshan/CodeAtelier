/**
 * 在已准备的真实 CodeAtelier ext4 夹具上测量 Linux Local 编译与私有存储成本。
 * 1. 直接编译建立结果对照，清除仅由本探针生成的对照产物，再组装生产 Controller/Service/Store。
 * 2. 两个真实 MXC Runtime 并行编译，分别核对产物摘要和执行区间；记录创建、挂载与读取缓存成本。
 * 3. 正常收尾核对 ready 和缓存回收；另建候选 Sandbox 编译并验证实际读依赖与候选清理。
 * 4. 保存 report、事件及 trace；失败保留现场，不自动恢复、安装依赖或启动用户服务。
 * 输入为独占夹具根、已有 Linux SDK 入口和当前 POSIX Runtime bundle，需通过正式 namespace 启动器运行。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
assert.ok(root && path.isAbsolute(root));
const source = path.join(root, "source");
const data = path.join(root, "data");
const storage = path.join(data, "local-overlays");
assert.equal(process.env.CODEATELIER_OVERLAY_ROOT, storage);
const log = pino({ enabled: false });
const traces = new TraceRecorder();
const archive = new TraceArchive(data, log);
const controller = new LinuxOverlayController(
  process.env.CODEATELIER_OVERLAY_SOCKET,
  log,
  traces,
  archive,
);
const report = {
  passed: false,
  preparation: JSON.parse(
    await readFile(path.join(root, "preparation.json"), "utf8"),
  ),
  opens: [],
  sessions: [],
  events: [],
};
const measuredController = {
  open: async (...args) => {
    const started = performance.now();
    const value = await controller.open(...args);
    report.opens.push({ ms: performance.now() - started, ready: value.ready });
    assert.equal(value.ready.copiedBytes, 0);
    assert.equal(value.ready.enumerations, 0);

    return value;
  },
  seal: (...args) => controller.seal(...args),
  close: (...args) => controller.close(...args),
  release: (...args) => controller.release(...args),
};
const backend = new LinuxLocalBackend(
  storage,
  measuredController,
  log,
  process.env.CODEATELIER_OVERLAY_VIEWS,
);
const service = new LocalOverlayService(data, log, backend);
const store = new Store(path.join(data, "history.sqlite"), { inline: true });
const validator = new LinuxCandidateValidator(
  storage,
  measuredController,
  log,
  process.env.CODEATELIER_OVERLAY_VIEWS,
);
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
const signal = () => AbortSignal.timeout(180000);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function measure(directory) {
  const value = {
    files: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
    cacheObjects: 0,
    cacheBytes: 0,
    cacheAllocatedBytes: 0,
  };
  async function visit(current) {
    const info = await lstat(current);
    value.allocatedBytes += info.blocks * 512;
    if (info.isDirectory()) {
      for (const name of await readdir(current)) {
        // Kernel work/work is mode 000 even for the Broker. Count only user
        // private data; do not change permissions to obtain a metric.
        if (
          current !== directory ||
          !["view", "lower", "work"].includes(name)
        ) {
          await visit(path.join(current, name));
        }
      }
    } else if (info.isFile()) {
      value.files++;
      value.logicalBytes += info.size;
      if (path.basename(current).startsWith("object-")) {
        value.cacheObjects++;
        value.cacheBytes += info.size;
        value.cacheAllocatedBytes += info.blocks * 512;
      }
    }
  }

  await visit(directory);

  return value;
}

async function compile(workspace) {
  const id = randomUUID();
  traces.startTask(id, id);
  const started = performance.now();
  const result = await runCandidateCommands({
    launcher: { launch: (value) => runtime.launchTask(value) },
    traces,
    log,
    sessionId: id,
    taskId: id,
    workspace,
    commands: [`${quote(process.execPath)} _project-compile.mjs`],
    signal: signal(),
    emit: async (type, event) => {
      report.events.push({ type, event });
    },
  });
  const output = JSON.parse(
    await readFile(path.join(workspace, ".overlay-build.json"), "utf8"),
  );
  output.runtimeMs = performance.now() - started;
  traces.finishTask(id, result.exitCode === 0 ? "ok" : "error");
  await archive.write(id, id, traces.exportTask(id));
  assert.deepEqual(result, {
    drained: true,
    sandboxApplied: true,
    exitCode: 0,
  });
  assert.equal(output.exitCode, 0, output.diagnostics);
  assert.equal(output.outputSha256, report.direct.outputSha256);

  return output;
}

try {
  await promisify(execFile)(process.execPath, ["_project-compile.mjs"], {
    cwd: source,
    timeout: 180000,
  });
  report.direct = JSON.parse(
    await readFile(path.join(source, ".overlay-build.json"), "utf8"),
  );
  assert.equal(report.direct.exitCode, 0, report.direct.diagnostics);
  for (const output of [
    "agent/engine.js",
    "server/main.js",
    "local-overlays/linux-backend.js",
  ]) {
    assert.ok(
      (await lstat(path.join(source, ".overlay-build", output))).isFile(),
    );
  }

  await rm(path.join(source, ".overlay-build"), { recursive: true });
  await rm(path.join(source, ".overlay-build.json"));
  const sessions = [];
  for (let index = 0; index < 2; index++) {
    const started = performance.now();
    const session = await service.create(
      { id: randomUUID(), source },
      async (workspace) =>
        store.create(workspace, "Real project build fixture"),
    );
    sessions.push(session);
    report.sessions.push({
      createMs: performance.now() - started,
      created: await measure(
        path.join(storage, backend.idFor(session.workspace)),
      ),
    });
  }

  const leases = await Promise.all(
    sessions.map((session) =>
      service.begin(session.workspace, session.id, randomUUID(), signal()),
    ),
  );
  const compilations = await Promise.allSettled(
    sessions.map((session) => compile(session.workspace)),
  );
  const outputs = compilations.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }

    return result.value;
  });
  assert.ok(
    Math.max(...outputs.map((value) => value.startedAt)) <
      Math.min(...outputs.map((value) => value.endedAt)),
  );
  report.parallel = true;
  for (const [index, session] of sessions.entries()) {
    const privateRoot = path.join(storage, backend.idFor(session.workspace));
    report.sessions[index].compile = outputs[index];
    report.sessions[index].afterCompile = await measure(privateRoot);
    const started = performance.now();
    const result = await leases[index].finish("completed", true);
    report.sessions[index].finishMs = performance.now() - started;
    assert.equal(result.phase, "ready");
    report.sessions[index].retained = await measure(privateRoot);
    assert.equal(report.sessions[index].retained.cacheObjects, 0);
    const round = JSON.parse(
      await readFile(path.join(privateRoot, "round.json"), "utf8"),
    );
    report.sessions[index].reads = round.reads.length;
  }

  const started = performance.now();
  const receipt = await validator.validate(
    source,
    new Map([
      [
        "tsconfig.server.json",
        await readFile(path.join(source, "tsconfig.server.json")),
      ],
    ]),
    async (workspace) => {
      report.candidateCompile = await compile(workspace);

      return { drained: true, sandboxApplied: true, exitCode: 0 };
    },
    signal(),
  );
  report.candidate = {
    ms: performance.now() - started,
    reads: receipt.reads.length,
  };
  assert.deepEqual(await readdir(path.join(data, "mxc", "active")), []);
  assert.equal((await readdir(source)).includes(".overlay-build"), false);
  await service.close();
  report.passed = true;
} catch (error) {
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  throw error;
} finally {
  await store.close();
  await writeFile(
    path.join(root, "project-build-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
