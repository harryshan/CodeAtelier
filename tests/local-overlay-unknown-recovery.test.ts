/**
 * 未知发布审核/接受协议的真实磁盘回归，由 Vitest 自动运行，不加载 Windows driver。
 * 1. fixture 通过真实 Publisher 制造首写后 unknown，显式注入执行证明以隔离状态机测试。
 * 2. 仅原生排他适配器使用替身；解锁仍核对真实锁摘要，来源/日志/备份行为用磁盘断言。
 * 3. 覆盖旧日志拒绝、陈旧审核、现场接受不重放、决定后解锁失败重试及新所有者锁保留。
 * PID/创建时间/句柄证据由手动 verify-lease 验证，本套件不替代 OS 执行排他验收。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { EditSession } from "../scripts/local-overlay/session.js";
import { Publisher } from "../scripts/local-overlay/publisher.js";
import {
  digest,
  durableJson,
  sourceIdentity,
} from "../scripts/local-overlay/files.js";
import { loadJournal } from "../scripts/local-overlay/journal.js";

const behavior = vi.hoisted(() => ({ failRelease: false }));
vi.mock("../scripts/local-overlay/publication-lease.js", () => ({
  PublicationLease: {
    start: async (gate: string) => ({
      signal: new AbortController().signal,
      close: async () => {},
      releaseLock: async (hash: string) => {
        if (behavior.failRelease) {
          throw new Error("injected release failure");
        }

        const lock = path.join(path.dirname(gate), "publish.lock");
        expect(digest(await readFile(lock))).toBe(hash);
        await unlink(lock);
      },
    }),
  },
}));

async function fixture(abortBeforeWrite = false) {
  behavior.failRelease = false;
  const root = await temp();
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.txt"), "old a\n");
  await writeFile(path.join(source, "b.txt"), "old b\n");
  const session = new EditSession(await sourceIdentity(source));
  await session.read("a.txt");
  await session.read("b.txt");
  await session.edit("a.txt", Buffer.from("new a\n"));
  await session.edit("b.txt", Buffer.from("new b\n"));
  const batch = session.seal();
  const publisher = new Publisher(path.join(root, "publisher"));
  await expect(
    publisher.publish(batch, {
      validate: async () => {
        if (abortBeforeWrite) {
          throw new Error("interrupted");
        }
      },
      afterWrite: async () => {
        throw new Error("interrupted");
      },
    }),
  ).rejects.toThrow("interrupted");
  const [key] = await readdir(publisher.directory);
  const directory = path.join(publisher.directory, key!);
  const lock = path.join(directory, "publish.lock");
  if (abortBeforeWrite) {
    await writeFile(lock, "retained aborted lock");
  }

  const file = path.join(directory, batch.id, "journal.json");
  const { journal } = await loadJournal(file, batch);
  journal.execution = {
    version: 1,
    generation: randomUUID(),
    lockDigest: digest(await readFile(lock)),
  };
  await durableJson(file, journal);

  return { publisher, batch, source, lock, file, journal };
}

it("refuses an old unknown journal without execution proof", async () => {
  const f = await fixture();
  delete f.journal.execution;
  await durableJson(f.file, f.journal);
  await expect(f.publisher.reviewUnknown(f.batch)).rejects.toThrow(
    "RECOVERY_EXECUTION_PROOF_MISSING",
  );
  expect(await readFile(f.lock)).toBeTruthy();
});

it("can explicitly release a quiescent aborted publication while retaining its original state", async () => {
  const f = await fixture(true);
  // A validation failure normally releases its lock. Model a failed execution
  // drain leaving the same lock; OS quiescence itself is tested natively.
  await writeFile(f.lock, "retained aborted lock");
  f.journal.execution!.lockDigest = digest(await readFile(f.lock));
  await durableJson(f.file, f.journal);
  const review = await f.publisher.reviewUnknown(f.batch);
  expect(review.files.map((entry) => entry.observed)).toEqual([
    "before",
    "before",
  ]);
  await f.publisher.acceptUnknown(f.batch, review.token);
  expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("old a\n");
  expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe("old b\n");
});

it("requires a fresh review and accepts current partial source without replay or rollback", async () => {
  const f = await fixture();
  const review = await f.publisher.reviewUnknown(f.batch);
  expect(review.files.map((entry) => entry.observed)).toEqual([
    "after",
    "before",
  ]);
  await writeFile(path.join(f.source, "b.txt"), "external b\n");
  await expect(
    f.publisher.acceptUnknown(f.batch, review.token),
  ).rejects.toThrow("RECOVERY_REVIEW_STALE");
  const current = await f.publisher.reviewUnknown(f.batch);
  await f.publisher.acceptUnknown(f.batch, current.token);
  expect((await f.publisher.inspect(f.batch)).state).toBe("reconciled");
  expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("new a\n");
  expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe(
    "external b\n",
  );
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    f.publisher.recoverRefresh(f.batch, "unused", async () => {}),
  ).rejects.toThrow("REFRESH_NOT_COMPLETE");
  await expect(
    f.publisher.publish(f.batch, { validate: async () => {} }),
  ).rejects.toMatchObject({ code: "EEXIST" });
});

it("retries a durable decision after failed lock release without reaccepting changed source", async () => {
  const f = await fixture();
  const review = await f.publisher.reviewUnknown(f.batch);
  behavior.failRelease = true;
  await expect(
    f.publisher.acceptUnknown(f.batch, review.token),
  ).rejects.toThrow("injected release failure");
  expect((await loadJournal(f.file, f.batch)).journal.state).toBe("reconciled");
  expect(await readFile(f.lock)).toBeTruthy();
  await writeFile(path.join(f.source, "a.txt"), "later source\n");
  behavior.failRelease = false;
  expect(
    (await f.publisher.acceptUnknown(f.batch, review.token)).alreadyAccepted,
  ).toBe(true);
  expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe(
    "later source\n",
  );
  await writeFile(f.lock, "new owner lock");
  expect(
    (await f.publisher.acceptUnknown(f.batch, review.token)).alreadyAccepted,
  ).toBe(true);
  expect(await readFile(f.lock, "utf8")).toBe("new owner lock");
});

it("does not accept changed locks, journal versions or cancellation", async () => {
  const f = await fixture();
  const review = await f.publisher.reviewUnknown(f.batch);
  await writeFile(f.file, JSON.stringify(f.journal));
  await expect(
    f.publisher.acceptUnknown(f.batch, review.token),
  ).rejects.toThrow("RECOVERY_REVIEW_STALE");
  await expect(
    f.publisher.reviewUnknown(
      f.batch,
      AbortSignal.abort(new Error("cancelled")),
    ),
  ).rejects.toThrow("cancelled");
  await writeFile(f.lock, "new owner");
  await expect(f.publisher.reviewUnknown(f.batch)).rejects.toThrow(
    "RECOVERY_LOCK_CHANGED",
  );
  expect(await readFile(f.lock, "utf8")).toBe("new owner");
});
