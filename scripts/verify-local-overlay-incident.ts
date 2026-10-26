/**
 * 手动验证产品 Service 的未知发布恢复，使用真实 WinFsp、原生 Publisher 和独占 NTFS 夹具。
 * 1. 两个私有文件明确选择发布；候选阶段以只读共享句柄占住第二个来源文件，使首写成功后第二写失败。
 * 2. 真实 finish 保留 failed 清单、私有锁和 B/O；通过服务审核现场，陈旧 token 拒绝，明确接受不回滚/补写。
 * 3. 固定决定重试幂等，新独立 Local 会话随后可正常发布，旧视图保持拒绝执行且未被清理。
 * 4. 所有文件和占用进程属于本脚本；不修改安装态、不调用模型/Sandbox、不运行 Evaluation。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import {
  LocalOverlayService,
  type LocalOverlayLease,
} from "../src/local-overlays/service.js";
import type { Session } from "../src/shared/types.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-incident-"));
const source = path.join(root, "source");
const data = path.join(root, "data");
await mkdir(source);
await mkdir(data);
await writeFile(path.join(source, "a.txt"), "old a\n");
await writeFile(path.join(source, "b.txt"), "old b\n");
const service = new LocalOverlayService(data, createLogger(root, "info"));
const bind = async (workspace: string) =>
  ({ id: randomUUID(), workspace }) as Session;
const signal = AbortSignal.timeout(120_000);
let blocker: ChildProcessWithoutNullStreams | undefined;
let blockerClosed: Promise<unknown> | undefined;
let lease: LocalOverlayLease | undefined;

async function releaseBlocker() {
  if (blocker) {
    blocker.stdin.end("release\n");
    await blockerClosed;
    blocker = undefined;
  }
}

try {
  const id = randomUUID();
  const parent = await service.create({ id, source }, bind);
  const taskId = randomUUID();
  lease = await service.begin(parent.workspace, parent.id, taskId, signal);
  assert(lease);
  await writeFile(path.join(parent.workspace, "a.txt"), "new a\n");
  await writeFile(path.join(parent.workspace, "b.txt"), "new b\n");
  await service.select(parent.workspace, parent.id, taskId, {
    paths: ["a.txt", "b.txt"],
    validate: async () => {
      blocker = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$file = [IO.File]::Open($env:CODEATELIER_INCIDENT_TARGET, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::ReadLine() } finally { $file.Dispose() }",
        ],
        {
          windowsHide: true,
          stdio: "pipe",
          env: {
            ...process.env,
            CODEATELIER_INCIDENT_TARGET: path.join(source, "b.txt"),
          },
        },
      );
      blocker.stderr.resume();
      blockerClosed = once(blocker, "close");
      const [output] = await once(blocker.stdout, "data", { signal });
      assert.equal(String(output).trim(), "ready");
    },
  });
  await assert.rejects(lease.finish("completed", true));
  lease = undefined;
  await releaseBlocker();
  assert.equal(await readFile(path.join(source, "a.txt"), "utf8"), "new a\n");
  assert.equal(await readFile(path.join(source, "b.txt"), "utf8"), "old b\n");
  const manifest = path.join(service.root, `${id}.json`);
  const privateLock = path.join(service.root, `${id}.lock`);
  const database = path.join(service.root, id, "overlay.sqlite");
  const before = await Promise.all([
    readFile(manifest),
    readFile(privateLock),
    readFile(database),
  ]);
  const inspected = await service.publicationRecovery(
    parent.workspace,
    parent.id,
    undefined,
    signal,
  );
  assert.equal(inspected.kind, "review");
  if (inspected.kind !== "review") {
    throw new Error("Expected source review");
  }

  assert.deepEqual(
    inspected.files.map((file) => file.observed),
    ["after", "before"],
  );
  await writeFile(path.join(source, "b.txt"), "external b\n");
  await assert.rejects(
    service.publicationRecovery(
      parent.workspace,
      parent.id,
      inspected.token,
      signal,
    ),
    /RECOVERY_REVIEW_STALE/,
  );
  const current = await service.publicationRecovery(
    parent.workspace,
    parent.id,
    undefined,
    signal,
  );
  assert.equal(current.kind, "review");
  if (current.kind !== "review") {
    throw new Error("Expected refreshed review");
  }

  assert.equal(
    (
      await service.publicationRecovery(
        parent.workspace,
        parent.id,
        current.token,
        signal,
      )
    ).kind,
    "accepted",
  );
  assert.deepEqual(
    await service.publicationRecovery(
      parent.workspace,
      parent.id,
      current.token,
      signal,
    ),
    { kind: "accepted", alreadyAccepted: true },
  );
  assert.deepEqual(
    await Promise.all([
      readFile(manifest),
      readFile(privateLock),
      readFile(database),
    ]),
    before,
  );
  await assert.rejects(
    service.begin(parent.workspace, parent.id, randomUUID(), signal),
  );

  const child = await service.create({ id: randomUUID(), source }, bind);
  const nextTask = randomUUID();
  lease = await service.begin(child.workspace, child.id, nextTask, signal);
  assert(lease);
  await writeFile(
    path.join(child.workspace, "next.txt"),
    "independent publish\n",
  );
  await service.select(child.workspace, child.id, nextTask, {
    paths: ["next.txt"],
    validate: async (files) => {
      assert.equal(files.get("next.txt")?.toString(), "independent publish\n");
    },
  });
  assert.equal(
    (await lease.finish("completed", true)).publication?.state,
    "published",
  );
  lease = undefined;
  assert.equal(
    await readFile(path.join(source, "next.txt"), "utf8"),
    "independent publish\n",
  );
  assert.equal(await readFile(path.join(source, "a.txt"), "utf8"), "new a\n");
  assert.equal(
    await readFile(path.join(source, "b.txt"), "utf8"),
    "external b\n",
  );
  const report = path.join(root, "report.json");
  await writeFile(
    report,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        passed: true,
        checks: [
          "real partial publication through Service finish",
          "native execution proof for review",
          "stale review rejected",
          "accept current without replay or rollback",
          "idempotent decision",
          "private manifest, lock and database unchanged",
          "failed private view stays blocked",
          "new Local view publishes after source recovery",
        ],
        limitations: [
          "Host fixture and trusted validator, not model/Sandbox v18",
          "No dirty-volume or private-view recovery",
          "No external writer CAS or multi-file atomicity",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_INCIDENT PASS report=${report}\n`);
} finally {
  await releaseBlocker();
  try {
    await lease?.finish("cancelled", true).catch(() => {});
  } finally {
    await service.close();
  }
}
