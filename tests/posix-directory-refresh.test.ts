/**
 * Linux 自身文件新增/删除后的目录读凭据确认回归，使用真实临时目录与 Publisher 日志。
 * 1. fixture 在已有 src 目录中发布一增一删，保留根、父目录和普通文件的原读凭据。
 * 2. 正常确认只推进改变的父目录版本，不修改输入、来源或无关凭据。
 * 3. 外部成员/类型/目录身份变化和不一致历史均拒绝，未 complete 日志不能用于确认。
 * 不模拟内核挂载成功；真实 whiteout、私有保留和续轮由 WSL backend 探针另验。
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { refreshPosixDirectoryReads } from "../src/local-overlays/posix-directory-refresh.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { readVersion } from "../src/local-overlays/publication/read-version.js";
import { EditSession } from "../src/local-overlays/publication/session.js";

async function fixture() {
  const root = await temp();
  const sourcePath = path.join(root, "source");
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(path.join(sourcePath, "src/old.txt"), "old\n");
  await writeFile(path.join(sourcePath, "src/keep.txt"), "keep\n");
  const source = await sourceIdentity(sourcePath);
  const session = new EditSession(source);
  await session.read("src/old.txt");
  await session.read("src/new.txt");
  await session.read("src/keep.txt");
  await session.edit("src/old.txt", null);
  await session.edit("src/new.txt", Buffer.from("new\n"));
  const batch = session.seal();
  for (const directory of [".", "src"]) {
    const read = { path: directory, kind: "directory" as const };
    batch.reads.push({ ...read, version: await readVersion(source, read) });
  }

  const publisher = new Publisher(path.join(root, "publications"));
  await publisher.publish(batch, { validate: async () => {} });
  const { journal } = await publisher.recordedJournal(source, batch.id);

  return { root, source, journal, reads: batch.reads };
}

it("acknowledges simultaneous creation and deletion only in the changed parent", async () => {
  const f = await fixture();
  const originalReads = structuredClone(f.reads);
  const refreshed = await refreshPosixDirectoryReads(f.journal, f.reads);
  expect(f.reads).toEqual(originalReads);
  expect(refreshed.filter((read) => read.path !== "src")).toEqual(
    f.reads.filter((read) => read.path !== "src"),
  );
  expect(refreshed.find((read) => read.path === "src")?.version).toBe(
    await readVersion(f.source, { path: "src", kind: "directory" }),
  );
  expect(refreshed.find((read) => read.path === "src")?.version).not.toBe(
    f.reads.find((read) => read.path === "src")?.version,
  );
  expect(await readFile(path.join(f.source.root, "src/new.txt"), "utf8")).toBe(
    "new\n",
  );
});

it.each(["member", "type", "identity"])(
  "rejects an unrelated parent %s change after publication",
  async (change) => {
    const f = await fixture();
    if (change === "member") {
      await writeFile(
        path.join(f.source.root, "src/external.txt"),
        "external\n",
      );
    } else if (change === "type") {
      await unlink(path.join(f.source.root, "src/keep.txt"));
      await mkdir(path.join(f.source.root, "src/keep.txt"));
    } else {
      await rename(
        path.join(f.source.root, "src"),
        path.join(f.root, "old-src"),
      );
      await mkdir(path.join(f.source.root, "src"));
      await writeFile(path.join(f.source.root, "src/new.txt"), "new\n");
      await writeFile(path.join(f.source.root, "src/keep.txt"), "keep\n");
    }

    await expect(
      refreshPosixDirectoryReads(f.journal, f.reads),
    ).rejects.toThrow("STALE_DEPENDENCY");
    expect(
      await readFile(path.join(f.source.root, "src/new.txt"), "utf8"),
    ).toBe("new\n");
  },
);

it("does not silently discard a different historical version of the same directory", async () => {
  const f = await fixture();
  f.reads.push({
    path: "src",
    kind: "directory",
    version: "directory-v1:older",
  });
  await expect(refreshPosixDirectoryReads(f.journal, f.reads)).rejects.toThrow(
    "STALE_DEPENDENCY",
  );
});

it("requires a completed publication before reconciling any membership", async () => {
  const f = await fixture();
  await expect(
    refreshPosixDirectoryReads({ ...f.journal, state: "applying" }, f.reads),
  ).rejects.toThrow("PUBLICATION_NOT_COMPLETE");
});
