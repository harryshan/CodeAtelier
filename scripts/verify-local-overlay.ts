/**
 * 显式手动验证 D170 第一阶段文件发布协议；不属于 Evaluation，不创建 Git 仓库。
 * 1. 在 .local 独占目录创建两会话基线，子进程屏障并行发布同文件不同行修改。
 * 2. 子进程对真实合并候选运行 Node --check，父进程执行最终文件确认两项变化均生效。
 * 3. 另一个子进程在替换后主动退出，核对日志/原文备份/现场/阻塞锁，拒绝自动重放。
 * 4. 保存平台、结果和证据路径；子进程有超时且以隐藏窗口运行，失败保留自己的现场。
 * 尚不接入 WinFsp、Sandbox、UI、自动回写或任意 shell 读依赖；产品默认模式不变。
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sourceIdentity } from "./local-overlay/files.js";
import { EditSession } from "./local-overlay/session.js";
import { Publisher } from "./local-overlay/publisher.js";

const execute = promisify(execFile);
await mkdir(".local", { recursive: true });
const root = await mkdtemp(
  path.join(process.cwd(), ".local", "local-overlay-poc-"),
);
function progress(stage: string) {
  process.stdout.write(`LOCAL_OVERLAY_POC ${stage}\n`);
}

function worker(mode: string, coordinator: string, manifest: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("scripts/local-overlay/worker.ts"),
      mode,
      coordinator,
      manifest,
    ],
    {
      windowsHide: true,
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let errors = "";
  let receipt: any;
  child.stdout!.resume();
  child.stderr!.on("data", (data: Buffer) => {
    errors = (errors + data.toString()).slice(-4096);
  });
  let ready = false;
  const started = new Promise<void>((resolve, reject) => {
    child.on("message", (message: any) => {
      if (message.state === "ready") {
        ready = true;
        resolve();
      } else {
        receipt = message;
      }
    });
    child.once("error", reject);
    child.once("close", () => {
      if (!ready) {
        reject(new Error(`Worker exited before ready: ${errors}`));
      }
    });
  });
  const closed = new Promise<{ code: number | null; receipt: any }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, receipt }));
    },
  );
  // Register rejection observers before awaiting either barrier or close.
  void started.catch(() => {});
  void closed.catch(() => {});

  return { started, closed, run: () => child.send("go") };
}

async function session(directory: string, changes: Record<string, string>) {
  const result = new EditSession(await sourceIdentity(directory));
  for (const [name, value] of Object.entries(changes)) {
    await result.read(name);
    await result.edit(name, Buffer.from(value));
  }

  return result;
}

async function concurrent() {
  const directory = path.join(root, "concurrent");
  const source = path.join(directory, "source");
  const coordinator = path.join(directory, "coordinator");
  await mkdir(source, { recursive: true });
  const base =
    "const first = 1;\nconst second = 2;\nprocess.stdout.write(String(first + second));\n";
  await writeFile(path.join(source, "module.mjs"), base);
  const first = await session(source, {
    "module.mjs": base.replace("first = 1", "first = 10"),
  });
  const second = await session(source, {
    "module.mjs": base.replace("second = 2", "second = 20"),
  });
  const a = path.join(directory, "a.json");
  const b = path.join(directory, "b.json");
  await first.save(a);
  await second.save(b);
  const workers = [
    worker("publish", coordinator, a),
    worker("publish", coordinator, b),
  ];
  await Promise.all(workers.map((entry) => entry.started));
  for (const entry of workers) {
    entry.run();
  }

  const results = await Promise.all(workers.map((entry) => entry.closed));
  for (const result of results) {
    assert.equal(result.code, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.state, "complete");
  }

  for (const editing of [first, second]) {
    const log = await readFile(
      path.join(coordinator, "diagnostics", editing.id, "logs", "app.log"),
      "utf8",
    );
    assert.match(log, /publish_started/);
    assert.match(log, /publish_finished/);
    assert.match(log, /outcome=ok/);
    assert.ok(!log.includes(source));
    assert.ok(!log.includes("const first"));
  }

  const execution = await execute(
    process.execPath,
    [path.join(source, "module.mjs")],
    { windowsHide: true, timeout: 5000 },
  );
  assert.equal(execution.stdout, "30");
  assert.deepEqual(await readdir(source), ["module.mjs"]);

  return {
    status: "passed",
    publishers: 2,
    finalProgramOutput: execution.stdout,
    candidateSyntaxChecks: "passed",
    lifecycleLogs: "passed; plain text without source paths or file content",
    journals: results.map((result) =>
      path.relative(root, result.receipt.directory),
    ),
  };
}

async function crash() {
  const directory = path.join(root, "crash");
  const source = path.join(directory, "source");
  const coordinator = path.join(directory, "coordinator");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "one.txt"), "original one\n");
  await writeFile(path.join(source, "two.txt"), "original two\n");
  const editing = await session(source, {
    "one.txt": "published one\n",
    "two.txt": "unpublished two\n",
  });
  const manifest = path.join(directory, "batch.json");
  await editing.save(manifest);
  const child = worker("crash", coordinator, manifest);
  await child.started;
  child.run();
  assert.equal((await child.closed).code, 86);
  const publisher = new Publisher(coordinator);
  const observed = await publisher.inspect(editing.seal());
  assert.deepEqual(observed, {
    state: "applying",
    files: [
      { path: "one.txt", recorded: "intent", observed: "matches_after" },
      { path: "two.txt", recorded: "pending", observed: "matches_before" },
    ],
  });
  const entries = await readdir(coordinator, { withFileTypes: true });
  const sourceKey = entries.find(
    (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
  );
  assert.ok(sourceKey);
  const journal = JSON.parse(
    await readFile(
      path.join(coordinator, sourceKey.name, editing.id, "journal.json"),
      "utf8",
    ),
  );
  assert.equal(
    Buffer.from(journal.entries[0].before.content, "base64").toString(),
    "original one\n",
  );
  assert.equal(
    Buffer.from(journal.entries[1].before.content, "base64").toString(),
    "original two\n",
  );
  await assert.rejects(
    publisher.publish(editing.seal(), {
      validate: async () => {},
      lockTimeoutMs: 100,
    }),
    /RECOVERY_REQUIRED/,
  );
  await writeFile(path.join(source, "one.txt"), "later external edit\n");
  const later = await publisher.inspect(editing.seal());
  assert.equal(later.files[0]!.observed, "diverged");
  assert.equal(
    await readFile(path.join(source, "one.txt"), "utf8"),
    "later external edit\n",
  );
  assert.equal(
    await readFile(path.join(source, "two.txt"), "utf8"),
    "original two\n",
  );

  return {
    status: "passed",
    exitCode: 86,
    observed,
    later,
    replay: "blocked",
    recovery: "inspect only; lock retained",
    originalBackups: "verified",
  };
}

progress(`started root=${root}`);
const concurrentResult = await concurrent();
progress("cross_process_publication_passed");
const crashResult = await crash();
progress("crash_recovery_observation_passed");
const report = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  release: os.release(),
  node: process.version,
  gitOperations: 0,
  concurrent: concurrentResult,
  crash: crashResult,
  limitations: [
    "Controlled file API only; no WinFsp or Sandbox integration",
    "No arbitrary external-writer CAS or multi-file atomicity",
    "Recovery observes and blocks; no automatic completion or rollback",
    "No Windows DACL-preserving replacement or directory rename validation",
  ],
};
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
progress(`PASS report=${path.join(root, "report.json")}`);
