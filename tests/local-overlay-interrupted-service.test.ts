/**
 * 中断参考的服务生命周期回归，使用真实清单/SQLite/文件与假挂载。
 * 1. 原生租约仅在此测试替换；实际读取、身份绑定、版本和参考播种均走生产代码。
 * 2. 中断检查及新会话保留旧清单/锁/数据，v3 材料不冒充三方预览或自动应用。
 * 3. 活动/错会话/错身份、证明失败、材料过期拒绝；完成请求幂等且不能改换恢复模式。
 * 4. 服务关闭取消并等待在途检查；真实进程退出证明由手动 WinFsp verifier 独立覆盖。
 */
import { randomUUID } from "node:crypto";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pino from "pino";
import { beforeEach, expect, it, vi } from "vitest";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { TestStore } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import {
  resolutionDirectory,
  resolutionGuidance,
} from "../src/local-overlays/resolution.js";
import { withLocalInspection } from "../src/local-overlays/inspection-lease.js";

vi.mock("../src/local-overlays/inspection-lease.js", () => ({
  withLocalInspection: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(withLocalInspection).mockReset();
  vi.mocked(withLocalInspection).mockImplementation(
    async (_control, signal, operation) => operation(signal),
  );
});

async function fixture() {
  const native = await nativeFixture();
  await native.change("edit.txt", "base", "partial bytes");
  await writeFile(path.join(native.source.root, "edit.txt"), "base");
  native.mutate(
    "CREATE TABLE nodes(id INTEGER PRIMARY KEY,object TEXT,info BLOB,reparse BLOB); CREATE TABLE entries(parent INTEGER,key TEXT,name TEXT,node INTEGER)",
  );
  const db = new DatabaseSync(path.join(native.control, "overlay.sqlite"));
  let object: string;
  try {
    object = String(
      db.prepare("SELECT object FROM sealed_changes").get()?.object,
    );
    db.prepare("INSERT INTO nodes VALUES(2,?,x'20000000',NULL)").run(object);
    db.exec(
      "INSERT INTO entries VALUES(1,'EDIT.TXT','edit.txt',2); UPDATE sealed_changes SET kind=0,object=''",
    );
  } finally {
    db.close();
  }

  const directory = await temp();
  const backend = new FakeLocalOverlayBackend(await temp());
  const service = new LocalOverlayService(
    directory,
    pino({ enabled: false }),
    backend,
  );
  const store = new TestStore(path.join(directory, "history.sqlite"));
  const bind = async (workspace: string) =>
    store.list().find((session) => session.workspace === workspace) ??
    store.create(workspace, "Interrupted reference");
  const id = randomUUID();
  const parent = await service.create({ id, source: native.source.root }, bind);
  const control = path.join(service.root, id);
  await cp(native.control, control, { recursive: true });
  const manifest = path.join(service.root, `${id}.json`);
  const lock = path.join(service.root, `${id}.lock`);
  const record = JSON.parse(await readFile(manifest, "utf8"));
  record.phase = "failed";
  await writeFile(manifest, JSON.stringify(record));
  await writeFile(lock, "retained unknown lease");
  const inspect = (signal = new AbortController().signal) =>
    service.reviewInterrupted(
      parent.workspace,
      parent.id,
      ["edit.txt"],
      signal,
    );

  return {
    native,
    service,
    backend,
    store,
    bind,
    id,
    parent,
    control,
    manifest,
    lock,
    record,
    object,
    inspect,
  };
}

it("preserves interrupted evidence and seeds a new reference without applying partial bytes", async () => {
  const f = await fixture();
  const before = await readFile(f.manifest);
  const database = await readFile(path.join(f.control, "overlay.sqlite"));
  const review = await f.inspect();
  expect(review.state).toBe("interrupted");
  expect(
    (await f.service.describe(f.parent)).localOverlay?.interruptedReview,
  ).toBe(true);
  const input = {
    id: randomUUID(),
    workspace: f.parent.workspace,
    sessionId: f.parent.id,
    paths: ["edit.txt"],
    state: "interrupted" as const,
    version: review.version,
  };
  const child = await f.service.continueResolution(input, f.bind);
  const folder = path.join(child.workspace, resolutionDirectory(input.id));
  const material = JSON.parse(
    await readFile(path.join(folder, "manifest.json"), "utf8"),
  );
  expect(material).toMatchObject({
    version: 3,
    state: "interrupted",
    publicationChecked: false,
    origin: { state: "interrupted", sessionId: f.parent.id },
  });
  expect(await readdir(child.workspace)).toEqual([
    resolutionDirectory(input.id),
  ]);
  expect(await readdir(path.join(folder, "0000"))).toEqual([
    "base",
    "interrupted-private",
  ]);
  expect(
    await readFile(path.join(folder, "0000", "interrupted-private"), "utf8"),
  ).toBe("partial bytes");
  expect(resolutionGuidance(input.id, material.origin)).toContain(
    "partial operation",
  );
  expect(
    (await f.service.describe(child)).localOverlay?.resolution?.state,
  ).toBe("interrupted");
  expect(await readFile(f.manifest)).toEqual(before);
  expect(await readFile(path.join(f.control, "overlay.sqlite"))).toEqual(
    database,
  );
  expect(await readFile(f.lock, "utf8")).toBe("retained unknown lease");
  expect(
    await readFile(path.join(f.native.source.root, "edit.txt"), "utf8"),
  ).toBe("base");

  await writeFile(
    path.join(f.control, "objects", f.object),
    "later interrupted material",
  );
  expect((await f.service.continueResolution(input, f.bind)).id).toBe(child.id);
  expect(f.backend.creates).toBe(2);
  await expect(
    f.service.continueResolution({ ...input, state: undefined }, f.bind),
  ).rejects.toThrow("已绑定");
  await expect(
    f.service.begin(
      f.parent.workspace,
      f.parent.id,
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await f.service.close();
});

it("refuses changed material before allocating a new view and keeps old locks", async () => {
  const f = await fixture();
  const review = await f.inspect();
  await writeFile(path.join(f.control, "objects", f.object), "changed");
  const id = randomUUID();
  await expect(
    f.service.continueResolution(
      {
        id,
        workspace: f.parent.workspace,
        sessionId: f.parent.id,
        paths: ["edit.txt"],
        state: "interrupted",
        version: review.version,
      },
      f.bind,
    ),
  ).rejects.toThrow("材料已经改变");
  expect(f.backend.creates).toBe(1);
  await expect(
    readFile(path.join(f.service.root, `${id}.json`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(path.join(f.service.root, `${id}.lock`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.lock, "utf8")).toBe("retained unknown lease");
  await f.service.close();
});

it("requires bound identities and a non-active parent; never bypasses a refused native lease", async () => {
  const f = await fixture();
  await expect(
    f.service.reviewInterrupted(
      f.parent.workspace,
      randomUUID(),
      ["edit.txt"],
      new AbortController().signal,
    ),
  ).rejects.toThrow("身份");
  await writeFile(
    f.manifest,
    JSON.stringify({ ...f.record, controlIdentity: "replaced" }),
  );
  await expect(f.inspect()).rejects.toThrow("身份");
  await writeFile(f.manifest, JSON.stringify({ ...f.record, phase: "ready" }));
  await expect(f.inspect()).rejects.toThrow("身份");
  expect(withLocalInspection).not.toHaveBeenCalled();
  await writeFile(f.manifest, JSON.stringify({ ...f.record, phase: "active" }));
  vi.mocked(withLocalInspection).mockRejectedValueOnce(
    new Error("native proof refused"),
  );
  await expect(f.inspect()).rejects.toThrow("native proof refused");
  expect(await readFile(f.lock, "utf8")).toBe("retained unknown lease");
  expect(f.backend.mounted.size).toBe(0);
  await f.service.close();
});

it("rejects a manifest changed during inspection instead of returning stale material", async () => {
  const f = await fixture();
  vi.mocked(withLocalInspection).mockImplementationOnce(
    async (_control, signal, operation) => {
      const result = await operation(signal);
      await writeFile(f.manifest, JSON.stringify({ ...f.record, epoch: 99 }));

      return result;
    },
  );
  await expect(f.inspect()).rejects.toThrow("身份改变");
  await f.service.close();
});

it("cancels and drains in-flight inspection when the service closes", async () => {
  const f = await fixture();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let drained = false;
  vi.mocked(withLocalInspection).mockImplementationOnce(
    async (_control, signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      drained = true;
      signal.throwIfAborted();
      throw new Error("Expected cancellation");
    },
  );
  const inspection = f.inspect();
  const rejected = expect(inspection).rejects.toThrow();
  await entered;
  await f.service.close();
  await rejected;
  expect(drained).toBe(true);
  expect(await readFile(f.lock, "utf8")).toBe("retained unknown lease");
});
