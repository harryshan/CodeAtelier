/**
 * 产品私有刷新恢复的持久生命周期回归，使用真实 Publisher/SQLite 和挂载替身。
 * 1. 真实来源发布后丢失确认，服务必须保存绑定 task/batch 的排空恢复资格。
 * 2. 新服务实例恢复时确认私有收据、保留来源后续编辑，解除原锁并允许新任务。
 * 3. 缺证明、并发、改选集和关闭未知均拒绝；只读失败可重试，未知收尾保留恢复锁。
 * 4. 当前 UI 恢复凭据只关联原任务；其它任务 ID 不投影，新一轮执行后清除，历史任务不改写。
 * 原生挂载、冻结和 Runtime 排空由实机验证另计，本文件不模拟成系统安全证据。
 */
import { randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pino from "pino";
import { expect, it } from "vitest";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import type { LocalOverlayMount } from "../src/local-overlays/backend.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import { PublishError } from "../src/local-overlays/publication/merge.js";
import type { Session } from "../src/shared/types.js";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { temp } from "./fixtures/helpers.js";

async function fixture() {
  const f = await nativeFixture();
  await writeFile(path.join(f.source.root, "code.txt"), "old\n");
  await f.change("code.txt", "old\n", "ours\n");
  const directory = await temp();
  const publications = path.join(directory, "local-overlays", "publications");
  const publisher = new Publisher(publications, pino({ enabled: false }));
  let failClose = false;
  let failRecovery = false;
  let beforeRecovery: ((signal: AbortSignal) => Promise<void>) | undefined;
  class Backend extends FakeLocalOverlayBackend {
    override async open(
      ...args: Parameters<FakeLocalOverlayBackend["open"]>
    ): Promise<LocalOverlayMount> {
      const mount = await super.open(...args);
      const control = args[2];

      return {
        ...mount,
        close: async () => {
          await mount.close();
          if (failClose) {
            throw new Error("close unknown");
          }
        },
        finish: async (task, plan) => {
          if (!plan) {
            return mount.finish(task);
          }

          const batch = await nativeBatch(
            f.source,
            control,
            plan.paths,
            async () => {},
          );
          await plan.record({
            state: "publishing",
            paths: [...plan.paths],
            batchId: batch.id,
          });
          await publisher.publish(batch, {
            validate: plan.validate,
            refresh: {
              request: batch.acknowledgement,
              checkpoint: batch.checkpoint,
              acknowledge: async () => {
                throw new Error("lost acknowledgement");
              },
            },
          });
          throw new PublishError("VIEW_REFRESH_PENDING");
        },
        recoverRefresh: async (batch, signal) => {
          await beforeRecovery?.(signal);
          if (failRecovery) {
            throw new Error("refresh rejected");
          }

          await publisher.recoverRefresh(
            batch,
            control,
            async (request) => {
              const db = new DatabaseSync(path.join(control, "overlay.sqlite"));
              try {
                db.prepare("INSERT INTO acknowledgements VALUES(?,?,?)").run(
                  request.batchId,
                  request.epoch,
                  request.seal,
                );
                db.exec(
                  "DELETE FROM baselines; DELETE FROM sealed_changes; UPDATE local_state SET epoch=5",
                );
              } finally {
                db.close();
              }
            },
            { signal },
          );
          await mount.close();

          return { epoch: 5 };
        },
      };
    }
  }
  const backend = new Backend(await temp());
  const service = () =>
    new LocalOverlayService(directory, pino({ enabled: false }), backend);
  const original = service();
  const id = randomUUID();
  const session = await original.create(
    { id, source: f.source.root },
    async (workspace) => ({ id: randomUUID(), workspace }) as Session,
  );
  const control = path.join(original.root, id);
  await cp(f.control, control, { recursive: true });
  const task = randomUUID();
  const lease = await original.begin(
    session.workspace,
    session.id,
    task,
    new AbortController().signal,
  );
  await original.select(session.workspace, session.id, task, {
    paths: ["code.txt"],
    validate: async () => {},
  });
  const recordFile = path.join(original.root, `${id}.json`);

  return {
    original,
    service,
    id,
    session,
    task,
    lease: lease!,
    backend,
    source: f.source.root,
    recordFile,
    record: async () => JSON.parse(await readFile(recordFile, "utf8")),
    setCloseFailure: (value: boolean) => {
      failClose = value;
    },
    setRecoveryFailure: (value: boolean) => {
      failRecovery = value;
    },
    beforeRecovery: (hook: (signal: AbortSignal) => Promise<void>) => {
      beforeRecovery = hook;
    },
  };
}

it("restores a proven clean refresh after service recreation without rewriting later source", async () => {
  const f = await fixture();
  await expect(f.lease.finish("completed", true)).rejects.toMatchObject({
    code: "VIEW_REFRESH_PENDING",
  });
  const saved = await f.record();
  expect(saved.refreshRecovery).toEqual({
    taskId: f.task,
    batchId: saved.publication.batchId,
  });
  await f.original.close();
  await writeFile(path.join(f.source, "code.txt"), "external\n");
  const service = f.service();
  const recover = () =>
    service.recoverPrivateRefresh(
      f.session.workspace,
      f.session.id,
      new AbortController().signal,
    );
  f.setRecoveryFailure(true);
  await expect(recover()).rejects.toThrow("refresh rejected");
  expect((await f.record()).phase).toBe("failed");
  f.setRecoveryFailure(false);
  await expect(recover()).resolves.toEqual({ recovered: true });
  expect(await readFile(path.join(f.source, "code.txt"), "utf8")).toBe(
    "external\n",
  );
  expect(await f.record()).toMatchObject({
    phase: "ready",
    epoch: 5,
    publication: { state: "published", files: 1 },
  });
  expect((await f.record()).refreshRecovery).toBeUndefined();
  expect(
    (await service.describe(f.session)).localOverlay?.refreshedTaskId,
  ).toBe(f.task);
  const recovered = await f.record();
  await writeFile(
    f.recordFile,
    JSON.stringify({ ...recovered, refreshedTaskId: randomUUID() }),
  );
  expect(
    (await service.describe(f.session)).localOverlay?.refreshedTaskId,
  ).toBeUndefined();
  await writeFile(f.recordFile, JSON.stringify(recovered));
  const next = await service.begin(
    f.session.workspace,
    f.session.id,
    randomUUID(),
    new AbortController().signal,
  );
  await next!.finish("cancelled", true);
  expect(
    (await service.describe(f.session)).localOverlay?.refreshedTaskId,
  ).toBeUndefined();
  await service.close();
});

it("does not record recovery eligibility when mount shutdown is unknown", async () => {
  const f = await fixture();
  f.setCloseFailure(true);
  await expect(f.lease.finish("completed", true)).rejects.toMatchObject({
    code: "VIEW_REFRESH_PENDING",
  });
  expect((await f.record()).refreshRecovery).toBeUndefined();
  await expect(
    f.original.recoverPrivateRefresh(
      f.session.workspace,
      f.session.id,
      new AbortController().signal,
    ),
  ).rejects.toThrow("证明");
  await f.original.close();
});

it("retains recovery guard and task lock when recovery shutdown is unknown", async () => {
  const f = await fixture();
  await expect(f.lease.finish("completed", true)).rejects.toThrow();
  f.setRecoveryFailure(true);
  f.setCloseFailure(true);
  await expect(
    f.original.recoverPrivateRefresh(
      f.session.workspace,
      f.session.id,
      new AbortController().signal,
    ),
  ).rejects.toThrow("close unknown");
  expect((await f.record()).phase).toBe("failed");
  for (const suffix of ["lock", "refresh.lock"]) {
    expect(
      await readFile(path.join(f.original.root, `${f.id}.${suffix}`), "utf8"),
    ).toBe("");
  }

  await f.original.close();
});

it("keeps the refresh control stable while active and drains it on service shutdown", async () => {
  const f = await fixture();
  await expect(f.lease.finish("completed", true)).rejects.toThrow();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.beforeRecovery(async (signal) => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("recovery cancelled")),
        { once: true },
      );
    });
  });
  const pending = f.original.recoverPrivateRefresh(
    f.session.workspace,
    f.session.id,
    new AbortController().signal,
  );
  const outcome = expect(pending).rejects.toThrow("recovery cancelled");
  await started;
  expect(
    (await f.original.describe(f.session)).localOverlay?.privateRefreshRecovery,
  ).toBe(true);
  await expect(
    f.original.recoverPrivateRefresh(
      f.session.workspace,
      f.session.id,
      new AbortController().signal,
    ),
  ).rejects.toThrow("非活动");
  await f.original.close();
  await outcome;
  expect(f.backend.mounted.size).toBe(0);
  expect((await f.record()).phase).toBe("failed");
  await expect(
    readFile(path.join(f.original.root, `${f.id}.refresh.lock`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects changed selection, task proof and concurrent recovery without deleting the task lock", async () => {
  const f = await fixture();
  await expect(f.lease.finish("completed", true)).rejects.toThrow();
  const original = await f.record();
  for (const change of [
    {
      ...original,
      refreshRecovery: { ...original.refreshRecovery, taskId: randomUUID() },
    },
    {
      ...original,
      publication: { ...original.publication, paths: ["other.txt"] },
    },
  ]) {
    await writeFile(f.recordFile, JSON.stringify(change));
    await expect(
      f.original.recoverPrivateRefresh(
        f.session.workspace,
        f.session.id,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(f.original.root, `${f.id}.lock`), "utf8"),
    ).toBe("");
  }

  await writeFile(f.recordFile, JSON.stringify(original));
  await writeFile(path.join(f.original.root, `${f.id}.refresh.lock`), "", {
    flag: "wx",
  });
  await expect(
    f.original.recoverPrivateRefresh(
      f.session.workspace,
      f.session.id,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(
    f.original.begin(
      f.session.workspace,
      f.session.id,
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("刷新");
  await f.original.close();
});
