/**
 * 目录成员依赖的宿主契约回归，使用独占真实文件/SQLite，不模拟 WinFsp 已验证。
 * 1. 目录版本区别名称/类型/身份变化，忽略普通文件内容和已清理临时项，拒绝越界/取消。
 * 2. 原生候选及主批次导出保留目录类型与根路径，并继续要求各代次原生有效凭据。
 * 3. Publisher 在候选结束后复核主/候选目录依赖，过期时不得改写选定源码。
 * 实机枚举、私有层和原生持久化由手动目录依赖 verifier 及 native import-test 覆盖。
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import {
  checkReadPath,
  readVersion,
} from "../src/local-overlays/publication/read-version.js";
import {
  EditSession,
  validateBatch,
} from "../src/local-overlays/publication/session.js";
import {
  candidateReads,
  validateReceipt,
} from "../src/local-overlays/candidate-reads.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";

const rootRead = { path: ".", kind: "directory" as const };

it("versions directory membership without recursive content or transient timestamp dependencies", async () => {
  const root = await temp();
  const source = await sourceIdentity(root);
  const file = path.join(root, "item");
  await writeFile(file, "old");
  const version = await readVersion(source, rootRead);
  await writeFile(file, "new content and size");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "temporary"), "temp");
  await unlink(path.join(root, "temporary"));
  expect(await readVersion(source, rootRead)).toBe(version);
  await rename(file, path.join(root, "renamed"));
  expect(await readVersion(source, rootRead)).not.toBe(version);
  await rename(path.join(root, "renamed"), file);
  await unlink(file);
  await mkdir(file);
  expect(await readVersion(source, rootRead)).not.toBe(version);
  await expect(
    readVersion(source, rootRead, AbortSignal.abort()),
  ).rejects.toThrow();
});

it("allows a root directory receipt without allowing root writes or invalid directory paths", async () => {
  expect(
    validateReceipt({ reads: [{ ...rootRead, version: "test" }] }).reads[0],
  ).toMatchObject(rootRead);
  for (const relative of ["..", "../escape", ".git", "a/.", "a\\b"]) {
    expect(() =>
      checkReadPath({ path: relative, kind: "directory" }),
    ).toThrow();
  }

  expect(() => checkReadPath({ path: "." })).toThrow();
  const f = await nativeFixture();
  const edit = new EditSession(f.source);
  await edit.read("file");
  await edit.edit("file", Buffer.from("new"));
  const batch = edit.seal();
  expect(() =>
    validateBatch({ ...batch, changes: [{ ...batch.changes[0], path: "." }] }),
  ).toThrow();
});

it("exports directory types from candidate and main observations and retains native proof", async () => {
  const f = await nativeFixture();
  await f.change("code.txt", "old", "merged");
  f.mutate(
    "INSERT INTO observations(path,name,stamp,epoch) VALUES('\\','\\','directory-v1:fixture',0); INSERT INTO checked_reads VALUES('\\',1,0)",
  );
  const receipt = await candidateReads(
    f.source,
    f.control,
    new Map([["code.txt", Buffer.from("merged")]]),
    async () => {},
  );
  expect(receipt.reads).toEqual([
    { ...rootRead, version: await readVersion(f.source, rootRead) },
  ]);
  const batch = await nativeBatch(
    f.source,
    f.control,
    ["code.txt"],
    async () => {},
  );
  expect(batch.reads).toEqual(receipt.reads);
  f.mutate("UPDATE checked_reads SET valid=0");
  await expect(
    nativeBatch(f.source, f.control, ["code.txt"], async () => {}),
  ).rejects.toThrow("STALE_DEPENDENCY");
  await expect(
    candidateReads(
      f.source,
      f.control,
      new Map([["code.txt", Buffer.from("merged")]]),
      async () => {},
    ),
  ).rejects.toThrow("STALE_VALIDATION_DEPENDENCY");
});

it.each(["main", "candidate"])(
  "rechecks %s directory membership before writing source",
  async (kind) => {
    const root = await temp();
    const directory = path.join(root, "source");
    await mkdir(directory);
    const source = await sourceIdentity(directory);
    await writeFile(path.join(directory, "edit.txt"), "base");
    const edit = new EditSession(source);
    await edit.read("edit.txt");
    await edit.edit("edit.txt", Buffer.from("ours"));
    const read = { ...rootRead, version: await readVersion(source, rootRead) };
    const batch = edit.seal();
    if (kind === "main") {
      batch.reads = [read];
    }

    await expect(
      new Publisher(path.join(root, "publish")).publish(batch, {
        validate: async () => {
          await writeFile(path.join(directory, "added.txt"), "external");

          return { reads: kind === "candidate" ? [read] : [] };
        },
      }),
    ).rejects.toMatchObject({
      outcome: "unapplied",
      code:
        kind === "main" ? "STALE_DEPENDENCY" : "STALE_VALIDATION_DEPENDENCY",
    });
    expect(await readFile(path.join(directory, "edit.txt"), "utf8")).toBe(
      "base",
    );
  },
);
