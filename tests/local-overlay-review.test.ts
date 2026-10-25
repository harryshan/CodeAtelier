/**
 * Local 只读 B/O/T 检查回归，使用真实文件和 SQLite，不模拟原生挂载保证。
 * 1. 检查冲突、缺失和二进制材料，确认内容合并只是预览且不清除陈旧依赖。
 * 2. 拒绝 dirty/旧格式/路径/对象/类型及大小错误；失败不改数据库或来源。
 * 3. 来源或代次改变使材料摘要变化，服务互斥/关闭另由生命周期回归覆盖。
 * 4. 批量检查绑定完整选集、拒绝重复或部分无效材料，限制文件数/路径/内容预算并复核来源。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import {
  reviewCleanFile,
  reviewCleanFiles,
  reviewSelection,
} from "../src/local-overlays/publication/review.js";
import * as files from "../src/local-overlays/publication/files.js";

async function fixture(
  base = "one\ntwo\nthree\n",
  ours = "ours\ntwo\nthree\n",
) {
  const f = await nativeFixture();
  await f.change("code.txt", base, ours);
  f.mutate("UPDATE meta SET clean=1");
  await writeFile(path.join(f.source.root, "code.txt"), base);

  return {
    ...f,
    review: (name = "code.txt", signal = new AbortController().signal) =>
      reviewCleanFile(f.source, f.control, name, signal),
  };
}

it("shows B/O/T and a preview without changing stale observations or source", async () => {
  const f = await fixture();
  f.mutate("INSERT INTO checked_reads VALUES('\\DEP.TXT',0,0)");
  await writeFile(path.join(f.source.root, "code.txt"), "one\ntwo\ntheirs\n");
  const database = path.join(f.control, "overlay.sqlite");
  const before = await readFile(database);
  const review = await f.review();
  expect(review.base.content).toBe(
    Buffer.from("one\ntwo\nthree\n").toString("base64"),
  );
  expect(review.ours.content).toBe(
    Buffer.from("ours\ntwo\nthree\n").toString("base64"),
  );
  expect(review.preview).toEqual({
    state: "merged",
    content: Buffer.from("ours\ntwo\ntheirs\n").toString("base64"),
  });
  expect(review.publicationChecked).toBe(false);
  expect((await f.review()).version).toBe(review.version);
  expect(await readFile(database)).toEqual(before);
  expect(await readFile(path.join(f.source.root, "code.txt"), "utf8")).toBe(
    "one\ntwo\ntheirs\n",
  );
});

it("keeps conflicts reviewable and binds versions to source and epoch", async () => {
  const f = await fixture("base", "ours");
  await writeFile(path.join(f.source.root, "code.txt"), "theirs");
  const first = await f.review();
  expect(first.preview).toEqual({ state: "conflict", reason: "TEXT_CONFLICT" });
  await writeFile(path.join(f.source.root, "code.txt"), "later");
  const second = await f.review();
  expect(second.version).not.toBe(first.version);
  f.mutate("UPDATE local_state SET epoch=1");
  expect((await f.review()).version).not.toBe(second.version);
});

it("distinguishes absence from empty files and preserves binary bytes", async () => {
  const f = await fixture();
  await f.change("new.txt", null, "");
  const created = await f.review("new.txt");
  expect(created.base.content).toBeNull();
  expect(created.ours.content).toBe("");
  expect(created.current.content).toBeNull();
  expect(created.preview).toEqual({ state: "merged", content: "" });

  await f.change("deleted.txt", "old", null);
  await writeFile(path.join(f.source.root, "deleted.txt"), "changed");
  expect((await f.review("deleted.txt")).preview).toEqual({
    state: "conflict",
    reason: "EXISTENCE_CONFLICT",
  });
  await f.change("binary.bin", "\0a", "\0b");
  await writeFile(path.join(f.source.root, "binary.bin"), "\0c");
  const binary = await f.review("binary.bin");
  expect(binary.ours.content).toBe(Buffer.from("\0b").toString("base64"));
  expect(binary.preview).toEqual({
    state: "conflict",
    reason: "UNMERGEABLE_CONTENT",
  });
});

it.each([
  ["UPDATE meta SET clean=0", "REVIEW_REQUIRES_CLEAN_VIEW"],
  ["UPDATE meta SET version=5", "REVIEW_REQUIRES_CLEAN_VIEW"],
  ["DELETE FROM sealed_changes", "NATIVE_CHANGE_MISSING"],
  ["UPDATE baselines SET kind=2", "NATIVE_CHANGE_UNSUPPORTED"],
  ["UPDATE baselines SET flags=4", "NATIVE_CHANGE_UNSUPPORTED"],
  ["UPDATE sealed_changes SET kind=4", "NATIVE_CHANGE_UNSUPPORTED"],
  ["UPDATE baselines SET object='../escape'", "NATIVE_OBJECT_INVALID"],
])("rejects unsupported state without mutation: %s", async (sql, reason) => {
  const f = await fixture();
  f.mutate(sql);
  const database = path.join(f.control, "overlay.sqlite");
  const before = await readFile(database);
  await expect(f.review()).rejects.toThrow(reason);
  expect(await readFile(database)).toEqual(before);
});

it.each(["../code.txt", ".git/config", "dir/.GiT", "code.txt:stream"])(
  "rejects unsafe path %s",
  async (name) => {
    const f = await fixture();
    await expect(f.review(name)).rejects.toThrow("PATH_REJECTED");
  },
);

it("rejects large content, absent selections, and cancellation", async () => {
  const f = await fixture();
  await expect(f.review("unknown.txt")).rejects.toThrow(
    "NATIVE_CHANGE_MISSING",
  );
  await writeFile(
    path.join(f.source.root, "code.txt"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  await expect(f.review()).rejects.toThrow("FILE_TYPE_OR_LIMIT");
  await expect(
    f.review("code.txt", AbortSignal.abort(new Error("cancelled"))),
  ).rejects.toThrow("cancelled");
});

it("binds the review version to private bytes and rejects oversized private content", async () => {
  const f = await fixture();
  const first = await f.review();
  const db = new DatabaseSync(path.join(f.control, "overlay.sqlite"), {
    readOnly: true,
  });
  const object = db.prepare("SELECT object FROM sealed_changes").get()!
    .object as string;
  db.close();
  const target = path.join(f.control, "objects", object);
  await writeFile(target, "later private");
  const later = await f.review();
  expect(later.version).not.toBe(first.version);
  expect(later.ours.content).toBe(
    Buffer.from("later private").toString("base64"),
  );
  await writeFile(target, Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(f.review()).rejects.toThrow("FILE_TYPE_OR_LIMIT");
});

it("rejects missing seals, source mismatch, and changed ancestors", async () => {
  const f = await fixture();
  f.mutate("UPDATE local_state SET seal=''");
  await expect(f.review()).rejects.toThrow();
  f.mutate(`UPDATE local_state SET seal='${f.seal}'`);
  await expect(
    reviewCleanFile(
      { ...f.source, identity: "replaced" },
      f.control,
      "code.txt",
      new AbortController().signal,
    ),
  ).rejects.toThrow("SOURCE_REPLACED");
  await f.change("dir\\code.txt", "base", "private");
  f.mutate(
    "INSERT INTO baselines VALUES('\\DIR','\\dir',2,'','directory',16,2)",
  );
  await expect(f.review("dir/code.txt")).rejects.toThrow(
    "NATIVE_ANCESTOR_CHANGE_UNSUPPORTED",
  );
});

it("binds the entire selection independent of order, preserving single-file versions", async () => {
  const f = await fixture();
  await f.change("second.txt", null, "new");
  const single = await f.review();
  const signal = new AbortController().signal;
  const first = await reviewCleanFiles(
    f.source,
    f.control,
    ["second.txt", "code.txt"],
    signal,
  );
  const second = await reviewCleanFiles(
    f.source,
    f.control,
    ["CODE.TXT", "second.txt"],
    signal,
  );
  expect(first).toEqual(second);
  expect(first.files.map((file) => file.path)).toEqual([
    "code.txt",
    "second.txt",
  ]);
  expect(first.files[0]?.version).toBe(single.version);
  await writeFile(path.join(f.source.root, "second.txt"), "external");
  expect(
    (
      await reviewCleanFiles(
        f.source,
        f.control,
        ["code.txt", "second.txt"],
        signal,
      )
    ).version,
  ).not.toBe(first.version);
});

it("rejects the whole group on duplicate or unsupported selections without mutation", async () => {
  const f = await fixture();
  const database = path.join(f.control, "overlay.sqlite");
  const before = await readFile(database);
  const signal = new AbortController().signal;
  await expect(
    reviewCleanFiles(f.source, f.control, ["code.txt", "CODE.TXT"], signal),
  ).rejects.toThrow("DUPLICATE_PATH");
  await expect(
    reviewCleanFiles(f.source, f.control, ["code.txt", "missing.txt"], signal),
  ).rejects.toThrow("NATIVE_CHANGE_MISSING");
  expect(await readFile(database)).toEqual(before);
  await f.change("unsupported.txt", "base", "ours");
  f.mutate("UPDATE baselines SET kind=2 WHERE path='\\UNSUPPORTED.TXT'");
  await expect(
    reviewCleanFiles(
      f.source,
      f.control,
      ["code.txt", "unsupported.txt"],
      signal,
    ),
  ).rejects.toThrow("NATIVE_CHANGE_UNSUPPORTED");
});

it("bounds group count, UTF-8 paths, and aggregate content including preview", async () => {
  expect(() => reviewSelection([])).toThrow("REVIEW_FILE_LIMIT");
  expect(() =>
    reviewSelection(Array.from({ length: 101 }, (_, index) => `${index}.txt`)),
  ).toThrow("REVIEW_FILE_LIMIT");
  expect(() =>
    reviewSelection(
      Array.from(
        { length: 100 },
        (_, index) => `文件${index}${"长".repeat(60)}`,
      ),
    ),
  ).toThrow("REVIEW_PATH_LIMIT");
  const f = await fixture();
  const selection = [];
  for (let index = 0; index < 3; index++) {
    const name = `large${index}.txt`;
    const content = "x".repeat(2 * 1024 * 1024);
    await f.change(name, content, content);
    await writeFile(path.join(f.source.root, name), content);
    selection.push(name);
  }

  await expect(
    reviewCleanFiles(
      f.source,
      f.control,
      selection.slice(0, 2),
      new AbortController().signal,
    ),
  ).resolves.toHaveProperty("files.length", 2);
  await expect(
    reviewCleanFiles(
      f.source,
      f.control,
      selection,
      new AbortController().signal,
    ),
  ).rejects.toThrow("REVIEW_CONTENT_LIMIT");
});

it("rejects a source file changed while reading another member of the group", async () => {
  const f = await fixture();
  await f.change("second.txt", null, "private");
  const original = files.snapshot;
  const spy = vi
    .spyOn(files, "snapshot")
    .mockImplementation(async (source, relative) => {
      if (source.root === f.source.root && relative === "second.txt") {
        await writeFile(
          path.join(f.source.root, "code.txt"),
          "changed during group read",
        );
      }

      return original(source, relative);
    });
  try {
    await expect(
      reviewCleanFiles(
        f.source,
        f.control,
        ["code.txt", "second.txt"],
        new AbortController().signal,
      ),
    ).rejects.toThrow("READ_CHANGED");
  } finally {
    spy.mockRestore();
  }
});
