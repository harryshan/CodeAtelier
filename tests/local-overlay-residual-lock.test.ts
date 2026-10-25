/**
 * 残留发布锁状态机回归，使用真实私有目录/日志与原生排他适配器替身。
 * 1. fixture 构造 v2 native claim 与明确批次，completed 保存实际格式的完整 journal。
 * 2. 验证缺失/替换锁、现存/后来出现 journal、旧 claim、取消和完成态保持。
 * 3. 替身仅核对传入 generation 与真实锁摘要，不宣称 OS 进程排空；实机由 verify-residual 覆盖。
 * 测试不需要 driver/helper，资源由 temp 管理，不触碰真实项目或运行 Evaluation。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { Publisher } from "../scripts/local-overlay/publisher.js";
import { EditSession } from "../scripts/local-overlay/session.js";
import {
  digest,
  durableJson,
  sourceIdentity,
} from "../scripts/local-overlay/files.js";
import type { Journal } from "../scripts/local-overlay/journal.js";

const hooks = vi.hoisted(() => ({
  mutated: false as boolean | undefined,
  start: undefined as undefined | (() => Promise<void>),
  generation: "",
}));
vi.mock("../scripts/local-overlay/publication-lease.js", () => ({
  PublicationLease: {
    start: async (gate: string, generation: string) => {
      expect(generation).toBe(hooks.generation);
      await hooks.start?.();

      return {
        sourceMutationStarted: hooks.mutated,
        signal: new AbortController().signal,
        close: async () => {},
        releaseLock: async (hash: string) => {
          const file = path.join(path.dirname(gate), "publish.lock");
          expect(digest(await readFile(file))).toBe(hash);
          await unlink(file);
        },
      };
    },
  },
}));
beforeEach(() => {
  hooks.start = undefined;
  hooks.mutated = false;
});

async function fixture() {
  const root = await temp();
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "code.txt"), "original\n");
  const identity = await sourceIdentity(source);
  const publisher = new Publisher(path.join(root, "publisher"));
  await publisher.publicationClaim(identity);
  const [key] = await readdir(publisher.directory);
  const directory = path.join(publisher.directory, key!);
  const session = new EditSession(identity);
  await session.read("code.txt");
  await session.edit("code.txt", Buffer.from("published\n"));
  const batch = session.seal();
  const claim = {
    version: 2,
    kind: "native",
    id: randomUUID(),
    pid: process.pid,
    batchId: batch.id,
  };
  hooks.generation = claim.id;
  const lock = path.join(directory, "publish.lock");
  await durableJson(lock, claim);
  const journalFile = path.join(directory, batch.id, "journal.json");
  const unstarted = () => publisher.releaseUnstartedLock(identity, claim.id);
  const completed = async () => {
    await mkdir(path.dirname(journalFile), { recursive: true });
    const journal: Journal = {
      version: 1,
      state: "complete",
      batch,
      execution: {
        version: 1,
        generation: claim.id,
        lockDigest: digest(await readFile(lock)),
      },
      entries: batch.changes.map((change) => ({
        path: change.path,
        before: change.base,
        after: change.ours,
        state: "written",
      })),
    };
    await durableJson(journalFile, journal);
    await writeFile(path.join(source, "code.txt"), "published\n");

    return journal;
  };

  return {
    source,
    identity,
    publisher,
    batch,
    claim,
    lock,
    journalFile,
    unstarted,
    completed,
  };
}

it("releases only an identified unstarted native claim and preserves source", async () => {
  const f = await fixture();
  await expect(
    f.publisher.releaseUnstartedLock(f.identity, randomUUID()),
  ).rejects.toThrow("RECOVERY_LOCK_CHANGED");
  expect((await f.unstarted()).released).toBe(true);
  expect((await f.unstarted()).released).toBe(false);
  expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
    "original\n",
  );
});

it.each([false, true])(
  "refuses a journal present before or during inspection: %s",
  async (during) => {
    const f = await fixture();
    const addJournal = async () => {
      await mkdir(path.dirname(f.journalFile), { recursive: true });
      await writeFile(f.journalFile, "not valid json");
    };

    if (during) {
      hooks.start = addJournal;
    } else {
      await addJournal();
    }

    await expect(f.unstarted()).rejects.toThrow("RECOVERY_JOURNAL_EXISTS");
    expect(await readFile(f.lock)).toBeTruthy();
  },
);

it("refuses legacy/host claims and changed locks", async () => {
  const f = await fixture();
  await durableJson(f.lock, { ...f.claim, kind: "host" });
  await expect(f.unstarted()).rejects.toThrow();
  await durableJson(f.lock, f.claim);
  hooks.start = async () => {
    await durableJson(f.lock, { ...f.claim, id: randomUUID() });
  };

  await expect(f.unstarted()).rejects.toThrow("RECOVERY_LOCK_CHANGED");
  expect(await readFile(f.lock)).toBeTruthy();
});

it("releases a complete batch without changing its journal, refresh or later source", async () => {
  const f = await fixture();
  const journal = await f.completed();
  journal.refresh = {
    state: "pending",
    request: {
      batchId: f.batch.id,
      epoch: 0,
      seal: randomUUID(),
      paths: ["\\code.txt"],
    },
  };
  await durableJson(f.journalFile, journal);
  const before = await readFile(f.journalFile, "utf8");
  await writeFile(path.join(f.source, "code.txt"), "later\n");
  expect((await f.publisher.releaseCompletedLock(f.batch)).released).toBe(true);
  expect(await readFile(f.journalFile, "utf8")).toBe(before);
  expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
    "later\n",
  );
  await durableJson(f.lock, { ...f.claim, id: randomUUID() });
  expect((await f.publisher.releaseCompletedLock(f.batch)).released).toBe(
    false,
  );
  expect(await readFile(f.lock)).toBeTruthy();
});

it("requires complete proof and rechecks journal version under inspection", async () => {
  const f = await fixture();
  const journal = await f.completed();
  journal.state = "unknown";
  await durableJson(f.journalFile, journal);
  await expect(f.publisher.releaseCompletedLock(f.batch)).rejects.toThrow(
    "RECOVERY_NOT_COMPLETE_WITH_PROOF",
  );
  journal.state = "complete";
  await durableJson(f.journalFile, journal);
  hooks.start = async () => {
    await writeFile(f.journalFile, JSON.stringify(journal));
  };

  await expect(f.publisher.releaseCompletedLock(f.batch)).rejects.toThrow(
    "JOURNAL_CHANGED",
  );
  expect(await readFile(f.lock)).toBeTruthy();
});

it("does not release after cancelled or unproven execution inspection", async () => {
  const f = await fixture();
  await expect(
    f.publisher.releaseUnstartedLock(
      f.identity,
      f.claim.id,
      AbortSignal.abort(new Error("cancelled")),
    ),
  ).rejects.toThrow("cancelled");
  hooks.start = async () => {
    throw new Error("active native execution");
  };

  await expect(f.unstarted()).rejects.toThrow("active native execution");
  expect(await readFile(f.lock)).toBeTruthy();
});

it.each([true, undefined])(
  "requires an explicit native no-write proof despite a missing journal: %s",
  async (mutated) => {
    const f = await fixture();
    hooks.mutated = mutated;
    await expect(f.unstarted()).rejects.toThrow(
      "RECOVERY_SOURCE_MAY_HAVE_CHANGED",
    );
    expect(await readFile(f.lock)).toBeTruthy();
  },
);
