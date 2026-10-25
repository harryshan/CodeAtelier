/**
 * 手动验证原生发布的残留锁恢复，使用独占 NTFS 来源和真实 helper/子进程。
 * 1. worker 包装当前进程的真实租约入口，仅在 ready 后或 close 前退出，分别留下无 journal/complete 锁。
 * 2. 主进程等待原宿主退出，以记录的原生 generation 证明排空；错误锁 ID 或任何现存 journal 均拒绝。
 * 3. 恢复只释放对应锁，保持来源后续修改和 complete journal；旧恢复请求不删除新发布所有者的锁。
 * 4. 原生身份复核的短暂 sharing 拒绝只重试同一检查，不重启写入；不处理旧格式或缺失执行证据。
 * 不改用户项目/服务/驱动，不进入默认 check/Evaluation，不替代 Sandbox 或私有卷恢复验证。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { PublicationLease } from "../src/local-overlays/publication/publication-lease.js";
import {
  EditSession,
  loadBatch,
} from "../src/local-overlays/publication/session.js";
import {
  sourceIdentity,
  durableJson,
} from "../src/local-overlays/publication/files.js";
import { PublishError } from "../src/local-overlays/publication/merge.js";

assert.equal(process.platform, "win32");

async function worker(root: string, mode: string) {
  const session = new EditSession(
    await sourceIdentity(path.join(root, "source")),
  );
  await session.read("code.txt");
  await session.edit("code.txt", Buffer.from("published\n"));
  await session.save(path.join(root, "batch.json"));
  const start = PublicationLease.start;
  PublicationLease.start = async (...args) => {
    const lease = await start(...args);
    if (mode === "unstarted") {
      process.exit(24);
    }

    lease.close = async () => {
      process.exit(25);
    };

    return lease;
  };

  await new Publisher(path.join(root, "publisher")).publish(session.seal(), {
    nativeWindows: true,
    validate: async () => {},
  });
}

async function afterTermination<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof PublishError) ||
        attempt >= 50 ||
        (error.cause as { nativeStatus?: number } | undefined)?.nativeStatus !==
          0xc0000043
      ) {
        throw error;
      }

      await delay(20);
    }
  }
}

async function scenario(root: string, mode: "unstarted" | "complete") {
  const directory = path.join(root, mode);
  const source = path.join(directory, "source");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "code.txt"), "original\n");
  const process = spawn(
    globalThis.process.execPath,
    [
      ...globalThis.process.execArgv,
      fileURLToPath(import.meta.url),
      "--worker",
      directory,
      mode,
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  process.stdout.resume();
  process.stderr.resume();
  const [code] = await once(process, "close");
  assert.equal(code, mode === "unstarted" ? 24 : 25);
  const publisher = new Publisher(path.join(directory, "publisher"));
  const identity = await sourceIdentity(source);
  const claim = await publisher.publicationClaim(identity);
  assert.ok(claim);
  const batch = await loadBatch(path.join(directory, "batch.json"));
  assert.equal(claim.batchId, batch.id);
  const [key] = await readdir(publisher.directory);
  const coordinator = path.join(publisher.directory, key!);
  const journalFile = path.join(coordinator, batch.id, "journal.json");
  let journal: string | undefined;
  if (mode === "unstarted") {
    await assert.rejects(readFile(journalFile), { code: "ENOENT" });
    await assert.rejects(
      publisher.releaseUnstartedLock(identity, randomUUID()),
      /RECOVERY_LOCK_CHANGED/,
    );
    await mkdir(path.dirname(journalFile), { recursive: true });
    await writeFile(journalFile, "invalid journal must not be discarded");
    await assert.rejects(
      publisher.releaseUnstartedLock(identity, claim.id),
      /RECOVERY_JOURNAL_EXISTS/,
    );
    await unlink(journalFile);
  } else {
    journal = await readFile(journalFile, "utf8");
    assert.equal(JSON.parse(journal).state, "complete");
    // Journal deletion must not erase native evidence that writes began.
    await unlink(journalFile);
    try {
      await assert.rejects(
        afterTermination(() =>
          publisher.releaseUnstartedLock(identity, claim.id),
        ),
        /RECOVERY_SOURCE_MAY_HAVE_CHANGED/,
      );
    } finally {
      await writeFile(journalFile, journal);
    }

    assert.equal(
      await readFile(path.join(source, "code.txt"), "utf8"),
      "published\n",
    );
    await writeFile(path.join(source, "code.txt"), "later external\n");
  }

  const release = () =>
    mode === "unstarted"
      ? publisher.releaseUnstartedLock(identity, claim.id)
      : publisher.releaseCompletedLock(batch);
  assert.equal((await afterTermination(release)).released, true);
  assert.equal(await publisher.publicationClaim(identity), null);
  assert.equal((await release()).released, false);
  assert.equal(
    await readFile(path.join(source, "code.txt"), "utf8"),
    mode === "unstarted" ? "original\n" : "later external\n",
  );
  if (journal) {
    assert.equal(await readFile(journalFile, "utf8"), journal);
  }

  const next = new EditSession(identity);
  await next.read("code.txt");
  await next.edit("code.txt", Buffer.from("next\n"));
  await publisher.publish(next.seal(), {
    nativeWindows: true,
    validate: async () => {
      const owner = await publisher.publicationClaim(identity);
      if (mode === "unstarted") {
        await assert.rejects(release(), /RECOVERY_LOCK_CHANGED/);
      } else {
        assert.equal((await release()).released, false);
      }

      assert.deepEqual(await publisher.publicationClaim(identity), owner);
    },
  });
  assert.equal(await readFile(path.join(source, "code.txt"), "utf8"), "next\n");

  return {
    mode,
    oldLockReleased: true,
    sourceAndJournalPreserved: true,
    nextPublicationPassed: true,
    newOwnerLockPreserved: true,
  };
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3]!, process.argv[4]!);
} else {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/local-overlay-residual-"));
  const results = [];
  for (const mode of ["unstarted", "complete"] as const) {
    results.push(await scenario(root, mode));
  }

  await durableJson(path.join(root, "report.json"), {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    results,
    limitations: [
      "Missing execution lease or old claims remain blocked",
      "Host NTFS fixture; no dirty volume or Sandbox product recovery",
      "No source rollback/replay or private object cleanup",
    ],
  });
  process.stdout.write(
    `LOCAL_OVERLAY_RESIDUAL PASS report=${path.join(root, "report.json")}\n`,
  );
}
