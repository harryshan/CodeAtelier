/**
 * Linux 原生观察清单 → 生产 Publisher → 新候选 MXC Runtime 的手动闭环。
 * 1. 通过独占 stdio 向父挂载控制器请求候选视图/seal/关闭，不接受外部连接。
 * 2. 从实际 lower 清单和私有视图导出两份批次，复用生产三方合并与来源串行发布。
 * 3. 每次验证建立全新视图，只播种候选源码，用真实 Runtime 执行 Python 检查；
 *    排空后导出新读依赖，核对候选源码未改写，再正常卸载。
 * 4. B 在 A 发布后保存状态并正常重挂载；旧 B 跨轮保留，发布确认后精确移除覆盖。
 * 5. 真实 Runtime 另制造重叠修改，确认发布拒绝并保留原私有结果/来源。
 * 报告和 trace 留在合成夹具，不调用模型服务、不开放产品入口或运行 Evaluation。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { MxcSandboxRuntime } from "../../src/sandbox/mxc-runtime.ts";
import { runCandidateCommands } from "../../src/local-overlays/command-runtime.ts";
import { TraceRecorder } from "../../src/tracing/recorder.ts";
import {
  posixBatch,
  posixReads,
  readPosixManifest,
} from "../../src/local-overlays/posix-batch.ts";
import {
  durableJson,
  sourceIdentity,
} from "../../src/local-overlays/publication/files.ts";
import {
  acknowledgePosixRound,
  capturePosixRound,
  posixRoundInputs,
  validatePosixRound,
} from "../../src/local-overlays/posix-round.ts";
import { Publisher } from "../../src/local-overlays/publication/publisher.ts";

const [root, sdkEntry, bundleDirectory] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
emit({ state: "ready" });
assert.equal((await lines.next()).value, "start");
let serial = 0;
async function request(action, fields = {}) {
  const id = ++serial;
  emit({ id, action, ...fields });
  const reply = JSON.parse((await lines.next()).value);
  assert.equal(reply.id, id);
  assert.equal(reply.ok, true);
  return reply;
}

const source = await sourceIdentity(path.join(root, "source"));
const seals = JSON.parse(await readFile(path.join(root, "seals.json"), "utf8"));
const broker = path.join(root, "publication-broker");
await mkdir(broker);
const traces = new TraceRecorder();
const log = pino({ enabled: false });
const sdk = await import(pathToFileURL(sdkEntry).href);
const runtime = new MxcSandboxRuntime({
  platform: "linux",
  dataDirectory: broker,
  bundleDirectory,
  nodeExecutable: process.execPath,
  traces,
  log,
  loadSdk: async () => sdk,
});
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const report = {
  passed: false,
  published: [],
  candidateRuns: 0,
  conflictRetained: false,
  unpublishedRemountRetained: false,
  publishedRefresh: false,
};

async function execute(workspace, command) {
  const taskId = randomUUID();
  traces.startTask(taskId, taskId);
  try {
    const result = await runCandidateCommands({
      launcher: { launch: (value) => runtime.launchTask(value) },
      traces,
      log,
      sessionId: taskId,
      taskId,
      workspace,
      commands: [command],
      signal: AbortSignal.timeout(60000),
      emit: async () => {},
    });
    assert.deepEqual(result, {
      drained: true,
      sandboxApplied: true,
      exitCode: 0,
    });
    traces.finishTask(taskId, "ok");
  } finally {
    await writeFile(
      path.join(root, `publication-trace-${taskId}.json`),
      JSON.stringify(traces.exportTask(taskId)),
    );
  }
}

async function batch(
  label,
  sealId,
  control = path.join(root, label, "control"),
  state,
) {
  return posixBatch({
    source,
    control,
    workspace: path.join(root, label, "view"),
    sealId,
    selected: ["module.py"],
    ...(state ? posixRoundInputs(state, source, ["module.py"]) : {}),
  });
}

try {
  const publications = path.join(root, "publications");
  const statePath = path.join(root, "B", "round.json");
  let state = await capturePosixRound({
    source,
    control: path.join(root, "B", "control"),
    sealId: seals.B,
    upper: path.join(root, "B", "upper"),
  });
  await durableJson(statePath, state);
  const publisher = new Publisher(publications, log);
  for (const index of [0, 1]) {
    let pending;
    if (index === 0) {
      pending = await batch("A", seals.A);
    } else {
      state = validatePosixRound(
        JSON.parse(await readFile(statePath, "utf8")),
        source,
      );
      const fresh = await request("refresh", { label: "B", remove: [] });
      await execute(
        fresh.workspace,
        `python3 -B -c ${quote("import pathlib; assert pathlib.Path('module.py').read_text() == 'a = 1\\nb = 20\\n'; assert pathlib.Path('artifact-B').read_text() == 'private'")}`,
      );
      const sealed = await request("seal", { label: "B" });
      state = await capturePosixRound({
        source,
        control: fresh.control,
        sealId: sealed.sealId,
        upper: path.join(root, "B", "upper"),
        previous: state,
      });
      await durableJson(statePath, state);
      pending = await batch("B", sealed.sealId, fresh.control, state);
      assert.equal(
        Buffer.from(pending.changes[0].base.content, "base64").toString(),
        "a = 1\nb = 2\n",
      );
      report.unpublishedRemountRetained = true;
    }
    await publisher.publish(pending, {
      validate: async (files) => {
        const candidate = await request("mount", {
          files: [...files].map(([file, content]) => [
            file,
            content?.toString("base64") ?? null,
          ]),
        });
        const expected = index === 0 ? "a = 10\nb = 2\n" : "a = 10\nb = 20\n";
        const python = `import pathlib, runpy; p=pathlib.Path('module.py'); assert p.read_text() == ${JSON.stringify(expected)}; v=runpy.run_path(str(p)); assert v['a'] + v['b'] == ${index === 0 ? 12 : 30}; pathlib.Path('candidate-artifact').write_text('private')`;
        await execute(candidate.workspace, `python3 -B -c ${quote(python)}`);
        assert.equal(
          await readFile(path.join(candidate.workspace, "module.py"), "utf8"),
          expected,
        );
        const sealed = await request("seal", { label: candidate.label });
        const manifest = await readPosixManifest(
          candidate.control,
          sealed.sealId,
          source,
        );
        const reads = await posixReads(
          source,
          candidate.control,
          manifest,
          new Set(files.keys()),
        );
        await request("close", { label: candidate.label });
        report.candidateRuns++;
        return { reads };
      },
    });
    report.published.push(pending.id);
    if (index === 1) {
      const acknowledged = await acknowledgePosixRound({
        state,
        batch: pending,
        publications,
        workspace: path.join(root, "B", "view"),
      });
      await durableJson(
        path.join(root, "B", "refresh-pending.json"),
        acknowledged,
      );
      const fresh = await request("refresh", {
        label: "B",
        remove: acknowledged.remove,
      });
      await execute(
        fresh.workspace,
        `python3 -B -c ${quote("import pathlib; assert pathlib.Path('module.py').read_text() == 'a = 10\\nb = 20\\n'; assert pathlib.Path('artifact-B').read_text() == 'private'")}`,
      );
      await durableJson(statePath, acknowledged.state);
      state = validatePosixRound(
        JSON.parse(await readFile(statePath, "utf8")),
        source,
      );
      assert.equal(
        state.baselines.some((entry) => entry.path === "module.py"),
        false,
      );
      assert.equal(
        state.baselines.some((entry) => entry.path === "artifact-B"),
        true,
      );
      assert.equal(
        (await readdir(path.join(root, "B", "upper"))).includes("module.py"),
        false,
      );
      report.publishedRefresh = true;
      report.retainedEpoch = state.epoch;
    }
  }
  const merged = "a = 10\nb = 20\n";
  assert.equal(
    await readFile(path.join(source.root, "module.py"), "utf8"),
    merged,
  );
  assert.deepEqual((await readdir(source.root)).sort(), [".git", "module.py"]);
  for (const label of ["A", "B"]) {
    assert.equal(
      await readFile(
        path.join(root, label, "view", `artifact-${label}`),
        "utf8",
      ),
      "private",
    );
  }
  const privateView = path.join(root, "A", "view");
  await execute(
    privateView,
    `node -e ${quote("require('node:fs').writeFileSync('module.py', 'a = 99\\nb = 2\\n')")}`,
  );
  const conflictSeal = await request("seal", { label: "A" });
  await assert.rejects(
    publisher.publish(await batch("A", conflictSeal.sealId), {
      validate: async () => {
        throw new Error("Conflict must precede candidate");
      },
    }),
    { reason: "TEXT_CONFLICT", outcome: "unapplied" },
  );
  assert.equal(
    await readFile(path.join(privateView, "module.py"), "utf8"),
    "a = 99\nb = 2\n",
  );
  assert.equal(
    await readFile(path.join(source.root, "module.py"), "utf8"),
    merged,
  );
  assert.deepEqual(await readdir(path.join(broker, "mxc", "active")), []);
  report.conflictRetained = true;
  report.passed = true;
} finally {
  await writeFile(
    path.join(root, "publication-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
emit({ action: "done" });
assert.equal((await lines.next()).value, "close");
input.close();
