/**
 * 完成态视图恢复的磁盘/SQLite 回归，由默认 Vitest 运行，不需要 WinFsp 或真实项目。
 * 1. pendingFixture 实际发布到隔离来源并故意丢失确认，构造持久 complete/pending。
 * 2. 检查重绑 seal、已有收据、同字节重写及后来修改；ack 回调仅模拟原生收据写入。
 * 3. 检查来源后续变更不被重放、未知日志/锁不被接管，以及日志版本与结构校验。
 * 原生冻结、收据选择校验及跨进程重启由手动 recovery verifier 验证，不把夹具等同挂载成功。
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import { nativeRefreshRequest } from "../src/local-overlays/publication/native-refresh.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { durableJson } from "../src/local-overlays/publication/files.js";
import {
  loadJournal,
  saveJournal,
  parseJournal,
} from "../src/local-overlays/publication/journal.js";
import type { OverlayAcknowledgement } from "../src/worktrees/overlay.js";

async function pendingFixture() {
  const f = await nativeFixture();
  await writeFile(path.join(f.source.root, "code.txt"), "old\n");
  await f.change("code.txt", "old\n", "ours\n");
  const batch = await nativeBatch(
    f.source,
    f.control,
    ["code.txt"],
    async () => {},
  );
  const coordinator = path.join(path.dirname(f.control), "publisher");
  const publisher = new Publisher(coordinator);
  const result = await publisher.publish(batch, {
    validate: async () => {},
    refresh: {
      request: batch.acknowledgement,
      checkpoint: batch.checkpoint,
      acknowledge: async () => {
        throw new Error("lost");
      },
    },
  });
  expect(result.refreshPending).toBe(true);
  const [key] = await readdir(coordinator);
  const journalFile = path.join(coordinator, key!, batch.id, "journal.json");
  const lock = path.join(coordinator, key!, "publish.lock");
  const journal = async () => (await loadJournal(journalFile, batch)).journal;
  const receipt = async (request: OverlayAcknowledgement) => {
    f.mutate(
      `INSERT INTO acknowledgements VALUES('${request.batchId}',${request.epoch},'${request.seal}'); DELETE FROM baselines; DELETE FROM sealed_changes; DELETE FROM change_epochs; UPDATE local_state SET epoch=epoch+1;`,
    );
  };

  return {
    ...f,
    batch,
    publisher,
    coordinator,
    journalFile,
    lock,
    journal,
    receipt,
  };
}

it("rebinds only unchanged private state and never rewrites later source edits", async () => {
  const f = await pendingFixture();
  const seal = randomUUID();
  f.mutate(`UPDATE local_state SET seal='${seal}'`);
  await writeFile(
    path.join(f.source.root, "code.txt"),
    "later external edit\n",
  );
  const restarted = new Publisher(f.coordinator);
  await restarted.recoverRefresh(f.batch, f.control, async (request) => {
    expect(request.seal).toBe(seal);
    await f.receipt(request);
  });
  expect(await readFile(path.join(f.source.root, "code.txt"), "utf8")).toBe(
    "later external edit\n",
  );
  expect((await f.journal()).refresh?.state).toBe("confirmed");
  expect((await f.journal()).refresh?.attempts?.[0]?.state).toBe("confirmed");
  await expect(
    restarted.recoverRefresh(f.batch, f.control, async () => {
      throw new Error("must not call");
    }),
  ).resolves.toMatchObject({ alreadyConfirmed: true });
});

it("persists recovery intent so a lost native receipt can be retried after later private edits", async () => {
  const f = await pendingFixture();
  const seal = randomUUID();
  f.mutate(`UPDATE local_state SET seal='${seal}'`);
  await expect(
    f.publisher.recoverRefresh(f.batch, f.control, async (request) => {
      await f.receipt(request);
      throw new Error("receipt lost");
    }),
  ).rejects.toThrow("receipt lost");
  expect((await f.journal()).refresh?.attempts?.[0]?.state).toBe("intent");
  await f.change("code.txt", "ours\n", "next private edit\n");
  f.mutate(`UPDATE local_state SET seal='${randomUUID()}'`);
  await new Publisher(f.coordinator).recoverRefresh(
    f.batch,
    f.control,
    async (request) => {
      expect(request.seal).toBe(seal);
      // Simulate only the idempotent receipt response, without deleting new B/O.
    },
  );
  const db = new DatabaseSync(path.join(f.control, "overlay.sqlite"));
  try {
    expect(db.prepare("SELECT count(*) AS n FROM baselines").get()?.n).toBe(1);
  } finally {
    db.close();
  }
});

it("rejects even a same-byte private rewrite with a changed physical version", async () => {
  const f = await pendingFixture();
  const [object] = await readdir(path.join(f.control, "objects"));
  const file = path.join(f.control, "objects", object!);
  await writeFile(file, "ours\n");
  await utimes(file, new Date(1_000_000), new Date(1_000_000));
  await expect(
    f.publisher.recoverRefresh(f.batch, f.control, async () => {
      throw new Error("must not call");
    }),
  ).rejects.toThrow("NATIVE_REFRESH_CHANGED");
  expect((await f.journal()).refresh?.state).toBe("pending");
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  "UPDATE change_epochs SET epoch=2",
  "UPDATE baselines SET stamp='changed'",
  "DELETE FROM sealed_changes",
])("refuses changed mappings or epochs: %s", async (sql) => {
  const f = await pendingFixture();
  f.mutate(sql);
  await expect(
    nativeRefreshRequest(
      f.source,
      f.control,
      f.batch.acknowledgement,
      f.batch.checkpoint,
    ),
  ).rejects.toThrow("NATIVE_REFRESH_CHANGED");
});

it("allows old journals only if the exact original native receipt exists", async () => {
  const f = await pendingFixture();
  await expect(
    nativeRefreshRequest(f.source, f.control, f.batch.acknowledgement),
  ).rejects.toThrow("NATIVE_CHECKPOINT_MISSING");
  await f.receipt(f.batch.acknowledgement);
  await expect(
    nativeRefreshRequest(f.source, f.control, f.batch.acknowledgement),
  ).resolves.toEqual(f.batch.acknowledgement);
  await expect(
    nativeRefreshRequest(f.source, f.control, {
      ...f.batch.acknowledgement,
      seal: randomUUID(),
    }),
  ).rejects.toThrow("NATIVE_RECEIPT_MISMATCH");
});

it.each(["unknown", "applying"] as const)(
  "never takes over a %s source lock",
  async (state) => {
    const f = await pendingFixture();
    const journal = await f.journal();
    journal.state = state;
    await durableJson(f.journalFile, journal);
    await writeFile(f.lock, "retained owner");
    await expect(
      f.publisher.recoverRefresh(f.batch, f.control, async () => {}, {
        lockTimeoutMs: 1,
      }),
    ).rejects.toThrow("REFRESH_NOT_COMPLETE");
    expect(await readFile(f.lock, "utf8")).toBe("retained owner");
  },
);

it("validates journal membership, terminal entries and guarded log updates", async () => {
  const f = await pendingFixture();
  const loaded = await loadJournal(f.journalFile, f.batch);
  const mismatch = structuredClone(loaded.journal);
  mismatch.entries[0]!.path = "another.txt";
  expect(() => parseJournal(mismatch)).toThrow("JOURNAL_BATCH_MISMATCH");
  mismatch.entries[0]!.path = "code.txt";
  mismatch.entries[0]!.state = "intent";
  expect(() => parseJournal(mismatch)).toThrow("JOURNAL_INCOMPLETE_ENTRIES");
  await expect(
    loadJournal(f.journalFile, { ...f.batch, id: randomUUID() }),
  ).rejects.toThrow("JOURNAL_BATCH_MISMATCH");
  await writeFile(f.journalFile, JSON.stringify(loaded.journal));
  await expect(
    saveJournal(f.journalFile, loaded.journal, loaded.version),
  ).rejects.toThrow("JOURNAL_CHANGED");
});

it("rejects a different control identity or selected-path proof", async () => {
  const f = await pendingFixture();
  const wrongControl = structuredClone(f.batch.checkpoint);
  wrongControl.control.identity = "different";
  await expect(
    nativeRefreshRequest(
      f.source,
      f.control,
      f.batch.acknowledgement,
      wrongControl,
    ),
  ).rejects.toThrow("NATIVE_CHECKPOINT_MISMATCH");
  const wrongPath = structuredClone(f.batch.checkpoint);
  wrongPath.files[0]!.name = "\\another.txt";
  await expect(
    nativeRefreshRequest(
      f.source,
      f.control,
      f.batch.acknowledgement,
      wrongPath,
    ),
  ).rejects.toThrow("NATIVE_CHECKPOINT_MISMATCH");
});

it("cancellation before recovery preserves pending without acquiring a source lock", async () => {
  const f = await pendingFixture();
  await expect(
    f.publisher.recoverRefresh(
      f.batch,
      f.control,
      async () => {
        throw new Error("must not call");
      },
      { signal: AbortSignal.abort(new Error("cancelled")) },
    ),
  ).rejects.toThrow("cancelled");
  expect((await f.journal()).refresh?.attempts).toBeUndefined();
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not overwrite a changed journal even after native acknowledgement succeeds", async () => {
  const f = await pendingFixture();
  await expect(
    f.publisher.recoverRefresh(f.batch, f.control, async (request) => {
      await f.receipt(request);
      const journal = await f.journal();
      await writeFile(f.journalFile, JSON.stringify(journal));
    }),
  ).rejects.toThrow("JOURNAL_CHANGED");
  expect((await f.journal()).refresh?.state).toBe("pending");
  await new Publisher(f.coordinator).recoverRefresh(
    f.batch,
    f.control,
    async (request) => {
      expect(request).toEqual(f.batch.acknowledgement);
    },
  );
  expect((await f.journal()).refresh?.state).toBe("confirmed");
});
