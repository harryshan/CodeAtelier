/**
 * 手动验证 Windows 发布执行排他，使用固定 helper、独占夹具和本脚本创建的进程。
 * 1. 普通会话覆盖替换/新建/删除/备份清理、并发检查拒绝、generation 不匹配和检查会话只读。
 * 2. raw helper 只用于故障注入：宿主存活但 helper 强杀必须拒绝，宿主退出但 helper 存活也拒绝。
 * 3. Publisher 子进程在首文件写入后直接退出，后续来源保持原文；只在真实执行结束后取得检查租约。
 * 4. 明确审核/接受当前现场，陈旧审核拒绝，旧批次不得重放；备份保留并验证新的发布可继续。
 * 此入口不进入 check/Evaluation；正常协议和取消边界另有默认单元测试。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { overlayHelperPath } from "../src/worktrees/overlay.js";
import { PublicationLease } from "./local-overlay/publication-lease.js";
import { Publisher } from "./local-overlay/publisher.js";
import { EditSession } from "./local-overlay/session.js";
import { digest, durableJson, sourceIdentity } from "./local-overlay/files.js";

assert.equal(process.platform, "win32");

async function rawLease(gate: string, owner: number) {
  const generation = randomUUID();
  const child = spawn(
    overlayHelperPath(),
    ["publish-session", gate, generation, String(owner)],
    { windowsHide: true, stdio: "pipe" },
  );
  const closed = once(child, "close");
  const [ready] = await once(child.stdout, "data");
  assert.equal(JSON.parse(String(ready)).state, "publication-ready");

  return { child, closed, generation };
}

async function inspectAfterExit(gate: string, generation: string) {
  // EOF may reach an orphan's stdin after its owning Node exits. Retry only
  // acquisition; never start another writer or infer termination from timeout.
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await PublicationLease.start(gate, generation);
    } catch (error) {
      last = error;
    }

    await delay(20);
  }

  throw last;
}

async function crashWorker(root: string) {
  const source = await sourceIdentity(path.join(root, "source"));
  const session = new EditSession(source);
  await session.read("a.txt");
  await session.read("b.txt");
  await session.edit("a.txt", Buffer.from("new a\n"));
  await session.edit("b.txt", Buffer.from("new b\n"));
  const batch = session.seal();
  await durableJson(path.join(root, "batch.json"), batch);
  await new Publisher(path.join(root, "publisher")).publish(batch, {
    nativeWindows: true,
    validate: async () => {},
    afterWrite: async (index) => {
      if (index === 0) {
        process.exit(23);
      }
    },
  });
}

async function verify() {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/local-overlay-lease-"));
  const gate = path.join(root, "normal.lease");
  const source = path.join(root, "source");
  await mkdir(source);
  const target = path.join(source, "code.txt");
  const temporary = path.join(
    source,
    `.codeatelier-publish-${randomUUID()}.tmp`,
  );
  const lease = await PublicationLease.start(gate);
  try {
    await assert.rejects(PublicationLease.start(gate, lease.generation));
    await writeFile(temporary, "created\n");
    await lease.create(target, temporary, digest("created\n"));
    assert.equal(await readFile(target, "utf8"), "created\n");
    await writeFile(temporary, "replaced\n");
    const backup = await lease.replace(
      target,
      temporary,
      digest("created\n"),
      digest("replaced\n"),
    );
    await lease.cleanup(temporary + ".backup", backup, digest("created\n"));
    await lease.delete(target, digest("replaced\n"));
    await assert.rejects(readFile(target), { code: "ENOENT" });
  } finally {
    await lease.close();
  }

  await assert.rejects(lease.create(target, temporary, digest("created\n")));
  await assert.rejects(PublicationLease.start(gate, randomUUID()));
  const inspection = await PublicationLease.start(gate, lease.generation);
  try {
    await writeFile(target, "do not delete\n");
    await assert.rejects(inspection.delete(target, digest("do not delete\n")));
    assert.equal(await readFile(target, "utf8"), "do not delete\n");
  } finally {
    await inspection.close();
  }

  const liveGate = path.join(root, "owner-alive.lease");
  const killed = await rawLease(liveGate, process.pid);
  killed.child.kill();
  await killed.closed;
  await assert.rejects(PublicationLease.start(liveGate, killed.generation));

  const owner: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { windowsHide: true, stdio: "pipe" },
  );
  const ownerClosed = once(owner, "close");
  await once(owner.stdout, "data");
  const orphanGate = path.join(root, "orphan.lease");
  const orphan = await rawLease(orphanGate, owner.pid!);
  try {
    owner.kill();
    await ownerClosed;
    await assert.rejects(PublicationLease.start(orphanGate, orphan.generation));
    orphan.child.stdin.end();
    await orphan.closed;
    const recovered = await PublicationLease.start(
      orphanGate,
      orphan.generation,
    );
    await recovered.close();
  } finally {
    owner.kill();
    orphan.child.kill();
    await ownerClosed;
    await orphan.closed;
  }

  await writeFile(path.join(source, "a.txt"), "old a\n");
  await writeFile(path.join(source, "b.txt"), "old b\n");
  const worker = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), "--crash", root],
    { windowsHide: true, stdio: "pipe" },
  );
  worker.stdout.resume();
  worker.stderr.resume();
  const [code] = await once(worker, "close");
  assert.equal(code, 23);
  const [key] = await readdir(path.join(root, "publisher"));
  const batch = JSON.parse(
    await readFile(path.join(root, "batch.json"), "utf8"),
  );
  const coordinator = path.join(root, "publisher", key!);
  const journal = JSON.parse(
    await readFile(path.join(coordinator, batch.id, "journal.json"), "utf8"),
  );
  assert.equal(journal.state, "applying");
  assert.equal(journal.entries[0].state, "intent");
  const recovered = await inspectAfterExit(
    path.join(coordinator, "execution.lease"),
    journal.execution.generation,
  );
  try {
    assert.equal(await readFile(path.join(source, "a.txt"), "utf8"), "new a\n");
    assert.equal(await readFile(path.join(source, "b.txt"), "utf8"), "old b\n");
    assert.equal(
      await readFile(path.join(source, journal.entries[0].backup.path), "utf8"),
      "old a\n",
    );
    await assert.rejects(
      new Publisher(path.join(root, "publisher")).publish(batch, {
        validate: async () => {},
        lockTimeoutMs: 10,
      }),
    );
    assert.ok(await readFile(path.join(coordinator, "publish.lock")));
  } finally {
    await recovered.close();
  }

  const publisher = new Publisher(path.join(root, "publisher"));
  const review = await publisher.reviewUnknown(batch);
  assert.deepEqual(
    review.files.map((entry) => entry.observed),
    ["after", "before"],
  );
  await writeFile(path.join(source, "b.txt"), "external b\n");
  await assert.rejects(
    publisher.acceptUnknown(batch, review.token),
    /RECOVERY_REVIEW_STALE/,
  );
  assert.ok(await readFile(path.join(coordinator, "publish.lock")));
  const updated = await publisher.reviewUnknown(batch);
  assert.equal(updated.files[1]!.observed, "diverged");
  await publisher.acceptUnknown(batch, updated.token);
  assert.equal((await publisher.inspect(batch)).state, "reconciled");
  await assert.rejects(readFile(path.join(coordinator, "publish.lock")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(path.join(source, "a.txt"), "utf8"), "new a\n");
  assert.equal(
    await readFile(path.join(source, "b.txt"), "utf8"),
    "external b\n",
  );
  assert.equal(
    await readFile(path.join(source, journal.entries[0].backup.path), "utf8"),
    "old a\n",
  );
  await assert.rejects(
    publisher.publish(batch, { nativeWindows: true, validate: async () => {} }),
  );
  const next = new EditSession(await sourceIdentity(source));
  await next.read("a.txt");
  await next.edit("a.txt", Buffer.from("next a\n"));
  await publisher.publish(next.seal(), {
    nativeWindows: true,
    validate: async () => {
      const lock = await readFile(
        path.join(coordinator, "publish.lock"),
        "utf8",
      );
      assert.equal(
        (await publisher.acceptUnknown(batch, updated.token)).alreadyAccepted,
        true,
      );
      assert.equal(
        await readFile(path.join(coordinator, "publish.lock"), "utf8"),
        lock,
      );
    },
  });
  assert.equal(await readFile(path.join(source, "a.txt"), "utf8"), "next a\n");

  await durableJson(path.join(root, "report.json"), {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    operations: "create/replace/cleanup/delete confirmed in one native session",
    exclusion:
      "live helper, live owner after helper kill and wrong generation rejected",
    orphan:
      "dead owner with live helper rejected; both exited permits inspection",
    interruptedPublisher:
      "first write intent preserved; second source untouched; backup and coordination lock retained",
    inspection: "cannot write source; original generation preserved",
    explicitResolution:
      "stale review rejected; current source accepted without replay/rollback; original backup retained",
    resumedPublication:
      "fresh batch succeeds; repeat resolution does not remove a new owner's lock",
    limitations: [
      "Explicit accept-current PoC; no product review UI or automatic unknown resolution",
      "No dirty overlay restore or external-writer CAS",
      "Host-only NTFS fixture, not Sandbox product publication",
    ],
  });
  process.stdout.write(
    `LOCAL_OVERLAY_LEASE PASS report=${path.join(root, "report.json")}\n`,
  );
}

if (process.argv[2] === "--crash") {
  await crashWorker(process.argv[3]!);
} else {
  await verify();
}
