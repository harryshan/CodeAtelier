/**
 * 未知发布审核/接受协议的真实磁盘回归，由 Vitest 自动运行，不加载 Windows driver。
 * 1. fixture 通过真实 Publisher 制造首写后 unknown，显式注入执行证明以隔离状态机测试。
 * 2. 仅原生排他适配器使用替身；解锁仍核对真实锁摘要，来源/日志/备份行为用磁盘断言。
 * 3. 覆盖旧日志拒绝、陈旧审核、现场接受不重放、决定后解锁失败重试及新所有者锁保留。
 * 4. 生产 HTTP/Service 从会话定位事故，校验鉴权/来源/批次/选集，接受后保留私有清单与残留锁。
 * PID/创建时间/句柄证据由手动 verify-lease 验证，本套件不替代 OS 执行排他验收。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import {
  digest,
  durableJson,
  sourceIdentity,
} from "../src/local-overlays/publication/files.js";
import { loadJournal } from "../src/local-overlays/publication/journal.js";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { createTestApp } from "./fixtures/managed-runtime.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";

const behavior = vi.hoisted(() => ({ failRelease: false }));
vi.mock("../src/local-overlays/publication/publication-lease.js", () => ({
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

async function fixture(
  abortBeforeWrite = false,
  publisherDirectory?: string,
  large = false,
) {
  behavior.failRelease = false;
  const root = await temp();
  const source = path.join(root, "source");
  await mkdir(source);
  const session = new EditSession(await sourceIdentity(source));
  for (const name of large ? ["a", "b", "c"] : ["a", "b"]) {
    await writeFile(
      path.join(source, `${name}.txt`),
      large ? "x".repeat(2 * 1024 * 1024) : `old ${name}\n`,
    );
    await session.read(`${name}.txt`);
    await session.edit(
      `${name}.txt`,
      Buffer.from(large ? "y".repeat(2 * 1024 * 1024) : `new ${name}\n`),
    );
  }

  const batch = session.seal();
  const publisher = new Publisher(
    publisherDirectory ?? path.join(root, "publisher"),
  );
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

async function productFixture(large = false) {
  const backend = new FakeLocalOverlayBackend(await temp());
  const app = await createTestApp(
    new Config(await temp()),
    pino({ enabled: false }),
    undefined,
    undefined,
    undefined,
    false,
    backend,
  );
  const service = app.engine.localOverlays;
  const f = await fixture(
    false,
    path.join(service.root, "publications"),
    large,
  );
  const id = randomUUID();
  const session = await service.create({ id, source: f.source }, (workspace) =>
    app.store.create(workspace, "Incident"),
  );
  const manifest = path.join(service.root, `${id}.json`);
  const record = JSON.parse(await readFile(manifest, "utf8"));
  record.phase = "failed";
  record.publication = {
    state: "publishing",
    paths: f.batch.changes.map((file) => file.path),
    batchId: f.batch.id,
  };
  await writeFile(manifest, JSON.stringify(record));
  const viewLock = path.join(service.root, `${id}.lock`);
  await writeFile(viewLock, "retained private lease");
  const bootstrap = (
    await app.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    })
  ).json();
  const headers = {
    host: "127.0.0.1",
    cookie: `ca_session=${bootstrap.token}`,
    "x-codeatelier-token": bootstrap.token,
  };

  return {
    ...f,
    ...app,
    backend,
    service,
    session,
    manifest,
    record,
    viewLock,
    headers,
  };
}

it("binds HTTP recovery to its session and keeps the failed private scene after accepting source", async () => {
  const f = await productFixture();
  const original = await readFile(f.manifest);
  const url = `/api/sessions/${f.session.id}/local-publication-review`;
  expect(
    (await f.app.inject({ method: "POST", url, payload: {} })).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        payload: {},
        headers: { host: f.headers.host, cookie: f.headers.cookie },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        payload: { batchId: f.batch.id },
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  const reviewed = await f.app.inject({
    method: "POST",
    url,
    payload: {},
    headers: f.headers,
  });
  expect(reviewed.statusCode).toBe(200);
  expect(reviewed.headers["cache-control"]).toBe("no-store");
  expect(
    reviewed.json().files.map((file: { observed: string }) => file.observed),
  ).toEqual(["after", "before"]);
  expect(reviewed.body).not.toContain(f.source);
  const accept = `/api/sessions/${f.session.id}/local-publication-accept`;
  await writeFile(path.join(f.source, "b.txt"), "external later");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: accept,
        payload: { token: reviewed.json().token },
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
  const current = await f.app.inject({
    method: "POST",
    url,
    payload: {},
    headers: f.headers,
  });
  const payload = { token: current.json().token };
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: accept,
        payload,
        headers: f.headers,
      })
    ).json().kind,
  ).toBe("accepted");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: accept,
        payload,
        headers: f.headers,
      })
    ).json().alreadyAccepted,
  ).toBe(true);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        payload: {},
        headers: f.headers,
      })
    ).json(),
  ).toEqual({ kind: "decision", token: payload.token });
  expect(await readFile(f.manifest)).toEqual(original);
  expect(await readFile(f.viewLock, "utf8")).toBe("retained private lease");
  expect(await readFile(path.join(f.source, "b.txt"), "utf8")).toBe(
    "external later",
  );
  expect((await f.service.describe(f.session)).localOverlay).toMatchObject({
    state: "failed",
    publicationRecovery: true,
  });
  await expect(
    f.service.begin(
      f.session.workspace,
      f.session.id,
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(await f.store.tasks(f.session.id)).toHaveLength(0);
  expect(f.backend.mounted.size).toBe(0);
});

it("rejects wrong ownership, recorded selection and journal identity without touching either lock", async () => {
  const f = await productFixture();
  await expect(
    f.service.publicationRecovery(f.session.workspace, randomUUID()),
  ).rejects.toThrow("身份");
  f.record.publication.paths = ["a.txt"];
  await writeFile(f.manifest, JSON.stringify(f.record));
  await expect(
    f.service.publicationRecovery(f.session.workspace, f.session.id),
  ).rejects.toThrow("选择");
  f.record.publication.paths = ["a.txt", "b.txt"];
  await writeFile(f.manifest, JSON.stringify(f.record));
  f.journal.batch.id = randomUUID();
  await durableJson(f.file, f.journal);
  await expect(
    f.service.publicationRecovery(f.session.workspace, f.session.id),
  ).rejects.toThrow("JOURNAL_BATCH_MISMATCH");
  f.journal.batch.id = f.batch.id;
  f.journal.batch.source.identity = "different-source";
  await durableJson(f.file, f.journal);
  await expect(
    f.service.publicationRecovery(f.session.workspace, f.session.id),
  ).rejects.toThrow("JOURNAL_BATCH_MISMATCH");
  expect(await readFile(f.lock)).toBeTruthy();
  expect(await readFile(f.viewLock)).toBeTruthy();
});

it("reports complete without a recovery action and refuses an active service task", async () => {
  const f = await productFixture();
  f.journal.state = "complete";
  for (const entry of f.journal.entries) {
    entry.state = "written";
  }

  await durableJson(f.file, f.journal);
  expect(
    await f.service.publicationRecovery(f.session.workspace, f.session.id),
  ).toEqual({ kind: "complete", refresh: "unrecorded" });
  await expect(
    f.service.publicationRecovery(
      f.session.workspace,
      f.session.id,
      "0".repeat(64),
    ),
  ).rejects.toThrow("RECOVERY_NOT_UNKNOWN");
  // Simulate a new, healthy service task separately; admission must not use its
  // in-memory active lease as evidence that the publisher has exited.
  f.record.phase = "ready";
  await writeFile(f.manifest, JSON.stringify(f.record));
  await unlink(f.viewLock);
  const lease = await f.service.begin(
    f.session.workspace,
    f.session.id,
    randomUUID(),
    new AbortController().signal,
  );
  await expect(
    f.service.publicationRecovery(f.session.workspace, f.session.id),
  ).rejects.toThrow("活动任务");
  await lease!.finish("cancelled", true);
});

it("keeps oversized incident contents off the public review response and retains recovery evidence", async () => {
  const f = await productFixture(true);
  const original = await readFile(f.manifest);
  await expect(
    f.service.publicationRecovery(f.session.workspace, f.session.id),
  ).rejects.toThrow("REVIEW_CONTENT_LIMIT");
  expect(await readFile(f.manifest)).toEqual(original);
  expect(await readFile(f.lock)).toBeTruthy();
  expect(await readFile(f.viewLock)).toBeTruthy();
});
