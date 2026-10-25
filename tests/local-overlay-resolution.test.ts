/**
 * 冲突继续服务的持久化与来源保留回归，使用真实文件/SQLite/Store，挂载由 FakeBackend 替换。
 * 1. 新视图仅携带选定参考，原清单/DB/源码不变；审核过期在创建前拒绝。
 * 2. 固定 ID 重试不重新读取后来材料、不重建或重复绑定；错误请求/未知挂载保持拒绝。
 * 3. 验证参考前缀禁止发布，Engine 实际指令指向参考并要求重新读取当前源码。
 * 4. 批量 v2 按编号保留缺失/空文件/二进制引用，整组审核过期拒绝，旧单文件 v1 仍可使用。
 * 假挂载不证明 live lower、原生 ACL 或 Sandbox；手动 verifier 单独覆盖真实 WinFsp。
 */
import { randomUUID } from "node:crypto";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { TestEngine, TestStore } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import { resolutionDirectory } from "../src/local-overlays/resolution.js";
import { publicationSelection } from "../src/local-overlays/publication.js";
import { Config } from "../src/config/config.js";

const log = pino({ enabled: false });

async function fixture() {
  const native = await nativeFixture();
  await native.change("code.txt", "base\n", "old private\n");
  native.mutate("UPDATE meta SET clean=1");
  await writeFile(path.join(native.source.root, "code.txt"), "external\n");
  const directory = await temp();
  const backend = new FakeLocalOverlayBackend(await temp());
  const service = new LocalOverlayService(directory, log, backend);
  const store = new TestStore(path.join(directory, "history.sqlite"));
  const bind = async (workspace: string) =>
    store.list().find((session) => session.workspace === workspace) ??
    store.create(workspace, "Resolution fixture");
  const parentId = randomUUID();
  const parent = await service.create(
    { id: parentId, source: native.source.root },
    bind,
  );
  await cp(native.control, path.join(service.root, parentId), {
    recursive: true,
  });
  const review = await service.review(
    parent.workspace,
    parent.id,
    "code.txt",
    new AbortController().signal,
  );
  const input = {
    id: randomUUID(),
    workspace: parent.workspace,
    sessionId: parent.id,
    path: review.path,
    version: review.version,
  };

  return {
    native,
    directory,
    backend,
    service,
    store,
    bind,
    parentId,
    parent,
    review,
    input,
  };
}

it("creates only a private reference and preserves the original view, dependencies and source", async () => {
  const f = await fixture();
  const manifest = path.join(f.service.root, `${f.parentId}.json`);
  const database = path.join(f.service.root, f.parentId, "overlay.sqlite");
  const oldManifest = await readFile(manifest);
  const oldDatabase = await readFile(database);
  const session = await f.service.continueResolution(f.input, f.bind);
  expect(session.id).not.toBe(f.parent.id);
  const folder = resolutionDirectory(f.input.id);
  expect(await readdir(session.workspace)).toEqual([folder]);
  expect(
    await readFile(path.join(session.workspace, folder, "ours"), "utf8"),
  ).toBe("old private\n");
  expect(
    await readFile(
      path.join(session.workspace, folder, "current-at-review"),
      "utf8",
    ),
  ).toBe("external\n");
  const reference = JSON.parse(
    await readFile(
      path.join(session.workspace, folder, "manifest.json"),
      "utf8",
    ),
  );
  expect(reference.origin.version).toBe(f.review.version);
  expect(reference.files.base.exists).toBe(true);
  expect(await readFile(manifest)).toEqual(oldManifest);
  expect(await readFile(database)).toEqual(oldDatabase);
  expect(
    await readFile(path.join(f.native.source.root, "code.txt"), "utf8"),
  ).toBe("external\n");
  expect((await f.service.describe(session)).localOverlay?.resolution).toEqual({
    sessionId: f.parent.id,
    path: "code.txt",
    directory: folder,
  });
  expect(f.backend.mounted.size).toBe(0);
  expect(() =>
    publicationSelection({
      paths: [`${folder}/ours`],
      validate: async () => {},
    }),
  ).toThrow("PATH_REJECTED");
  await f.service.close();
});

async function batchFixture() {
  const f = await fixture();
  await f.native.change("empty.txt", null, "");
  await f.native.change("removed.bin", "\0base", null);
  await cp(f.native.control, path.join(f.service.root, f.parentId), {
    recursive: true,
  });
  const paths = ["removed.bin", "code.txt", "empty.txt"];
  const review = await f.service.reviewBatch(
    f.parent.workspace,
    f.parent.id,
    paths,
    new AbortController().signal,
  );
  const input = {
    id: randomUUID(),
    workspace: f.parent.workspace,
    sessionId: f.parent.id,
    paths,
    version: review.version,
  };

  return { ...f, review, input };
}

it("seeds a numbered group of exact references and retries the whole intent without duplication", async () => {
  const f = await batchFixture();
  const database = path.join(f.service.root, f.parentId, "overlay.sqlite");
  const before = await readFile(database);
  const session = await f.service.continueResolution(f.input, f.bind);
  const folder = resolutionDirectory(f.input.id);
  const directory = path.join(session.workspace, folder);
  expect(await readdir(session.workspace)).toEqual([folder]);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  expect(manifest.version).toBe(2);
  expect(
    manifest.entries.map((entry: { path: string; directory: string }) => [
      entry.path,
      entry.directory,
    ]),
  ).toEqual([
    ["code.txt", "0000"],
    ["empty.txt", "0001"],
    ["removed.bin", "0002"],
  ]);
  expect(await readFile(path.join(directory, "0000", "ours"), "utf8")).toBe(
    "old private\n",
  );
  expect(await readFile(path.join(directory, "0001", "ours"))).toHaveLength(0);
  expect(manifest.entries[1].files.base.exists).toBe(false);
  expect(manifest.entries[2].files.ours.exists).toBe(false);
  expect(await readFile(path.join(directory, "0002", "base"))).toEqual(
    Buffer.from("\0base"),
  );
  expect(await readFile(database)).toEqual(before);
  expect(
    (await f.service.describe(session)).localOverlay?.resolution?.paths,
  ).toEqual(["code.txt", "empty.txt", "removed.bin"]);

  await writeFile(
    path.join(f.native.source.root, "empty.txt"),
    "later external",
  );
  expect(
    (
      await f.service.continueResolution(
        { ...f.input, paths: [...f.input.paths].reverse() },
        f.bind,
      )
    ).id,
  ).toBe(session.id);
  expect(f.backend.creates).toBe(2);
  expect(f.store.list()).toHaveLength(2);
  await expect(
    f.service.continueResolution({ ...f.input, paths: ["code.txt"] }, f.bind),
  ).rejects.toThrow("已绑定");
  await f.service.close();
});

it("refuses the entire group before allocation if any selected source changes", async () => {
  const f = await batchFixture();
  await writeFile(
    path.join(f.native.source.root, "empty.txt"),
    "new source member",
  );
  await expect(f.service.continueResolution(f.input, f.bind)).rejects.toThrow(
    "材料已经改变",
  );
  expect(f.backend.creates).toBe(1);
  expect(f.store.list()).toHaveLength(1);
  await expect(
    readFile(path.join(f.service.root, `${f.input.id}.json`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.service.describe(f.parent)).localOverlay?.state).toBe(
    "ready",
  );
  await f.service.close();
});

it("rejects a stale review before allocating and leaves both source and old view reusable", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.native.source.root, "code.txt"),
    "later external\n",
  );
  await expect(f.service.continueResolution(f.input, f.bind)).rejects.toThrow(
    "材料已经改变",
  );
  expect(f.backend.creates).toBe(1);
  await expect(
    readFile(path.join(f.service.root, `${f.input.id}.json`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(path.join(f.service.root, `${f.input.id}.lock`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.service.describe(f.parent)).localOverlay?.state).toBe(
    "ready",
  );
  await f.service.close();
});

it("reuses a completed request after later source changes and rejects different intent for its ID", async () => {
  const f = await fixture();
  const first = await f.service.continueResolution(f.input, f.bind);
  await writeFile(path.join(f.native.source.root, "code.txt"), "later");
  expect((await f.service.continueResolution(f.input, f.bind)).id).toBe(
    first.id,
  );
  expect(f.backend.creates).toBe(2);
  expect(f.store.list()).toHaveLength(2);
  await expect(
    f.service.continueResolution(
      { ...f.input, version: "0".repeat(64) },
      f.bind,
    ),
  ).rejects.toThrow("已绑定");
  await expect(
    f.service.create({ id: f.input.id, source: f.native.source.root }, f.bind),
  ).rejects.toThrow("已绑定");
  await expect(
    f.service.continueResolution({ ...f.input, id: f.parentId }, f.bind),
  ).rejects.toThrow("新的");
  await f.service.close();
});

it("recovers a lost session binding response without seeding twice", async () => {
  const f = await fixture();
  await expect(
    f.service.continueResolution(f.input, async (workspace) => {
      await f.bind(workspace);
      throw new Error("lost reply");
    }),
  ).rejects.toThrow("lost reply");
  const session = await f.service.continueResolution(f.input, f.bind);
  expect(f.store.list()).toHaveLength(2);
  expect(f.backend.creates).toBe(2);
  expect(
    await readFile(
      path.join(session.workspace, resolutionDirectory(f.input.id), "ours"),
      "utf8",
    ),
  ).toBe("old private\n");
  await f.service.close();
});

it("retains an unknown new view without damaging or reusing the old one", async () => {
  const f = await fixture();
  f.backend.failOpen = true;
  await expect(f.service.continueResolution(f.input, f.bind)).rejects.toThrow(
    "mount failed",
  );
  const failed = JSON.parse(
    await readFile(path.join(f.service.root, `${f.input.id}.json`), "utf8"),
  );
  expect(failed.phase).toBe("failed");
  expect((await f.service.describe(f.parent)).localOverlay?.state).toBe(
    "ready",
  );
  f.backend.failOpen = false;
  await expect(f.service.continueResolution(f.input, f.bind)).rejects.toThrow(
    "未知",
  );
  await f.service.close();
});

it("supplies trusted reference guidance to a fresh Engine task without copying old conversation", async () => {
  const f = await fixture();
  const session = await f.service.continueResolution(f.input, f.bind);
  let instructions = "";
  const engine = new TestEngine(
    f.store,
    new Config(f.directory),
    log,
    () => ({
      async run(_input, value) {
        instructions = value;

        return { text: "checked", output: [] };
      },
    }),
    undefined,
    undefined,
    f.backend,
  );
  const task = await engine.start(session.id, "Reconcile current source");
  await engine.active?.done;
  expect(f.store.task(task.id)?.status).toBe("completed");
  expect(instructions).toContain(resolutionDirectory(f.input.id));
  expect(instructions).toContain("untrusted historical data");
  expect(instructions).toContain("Re-read current source");
  expect(instructions).not.toContain("old private\n");
  await engine.close();
  await f.service.close();
});
