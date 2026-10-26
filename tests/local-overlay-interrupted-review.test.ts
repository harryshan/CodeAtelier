/**
 * 中断现场只读材料检查的 SQLite/文件契约回归，不把夹具当成原生进程退出证明。
 * 1. 使用真实 v6 表及私有字节，证明 current namespace 优先于过期 sealed_changes。
 * 2. 检查路径归属、祖先修改、对象缺失/硬链接、数据库格式、取消与只读内容限额。
 * 3. 输出始终保留 interrupted 和禁止发布声明；不重挂载、清 clean、改来源或删除服务锁。
 * 原生排他/进程身份与真实中断由手动 overlay:verify-interrupted 验证。
 */
import { link, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import { readInterruptedFiles } from "../src/local-overlays/interrupted-review.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";

async function fixture(name = "edit.txt") {
  const f = await nativeFixture();
  await f.change(name, "original", "partial private");
  f.mutate(
    "CREATE TABLE nodes(id INTEGER PRIMARY KEY,object TEXT,info BLOB,reparse BLOB); CREATE TABLE entries(parent INTEGER,key TEXT,name TEXT,node INTEGER)",
  );
  const db = new DatabaseSync(path.join(f.control, "overlay.sqlite"));
  let object: string;
  try {
    object = String(
      db.prepare("SELECT object FROM sealed_changes").get()?.object,
    );
    db.prepare("INSERT INTO nodes VALUES(2,?,x'20000000',NULL)").run(object);
    db.prepare("INSERT INTO entries VALUES(1,?,?,2)").run(
      name.toUpperCase(),
      name,
    );
    // Simulate a stale seal from an earlier round; recovery must use nodes.
    db.exec("UPDATE sealed_changes SET kind=0,object=''");
  } finally {
    db.close();
  }

  const control = await sourceIdentity(f.control);

  return {
    ...f,
    object,
    inspect: (paths = [name], signal = new AbortController().signal) =>
      readInterruptedFiles(
        f.source,
        control,
        paths,
        signal,
        path.join(path.dirname(f.control), "snapshots"),
      ),
  };
}

it("reads current partial objects, preserving dirty metadata and stale seal", async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.control, "overlay.sqlite"));
  const result = await f.inspect();
  expect(result).toMatchObject({
    state: "interrupted",
    publicationChecked: false,
  });
  expect(Buffer.from(result.files[0]!.base.content!, "base64").toString()).toBe(
    "original",
  );
  expect(
    Buffer.from(result.files[0]!.private.content!, "base64").toString(),
  ).toBe("partial private");
  expect(await readFile(path.join(f.control, "overlay.sqlite"))).toEqual(
    before,
  );
});

it("distinguishes deletion from private file with a missing object", async () => {
  const f = await fixture();
  f.mutate("UPDATE nodes SET object=''");
  await expect(f.inspect()).rejects.toThrow("NATIVE_OBJECT_INVALID");
  f.mutate("UPDATE entries SET node=0");
  expect((await f.inspect()).files[0]!.private.content).toBeNull();
});

it.each([
  ["UPDATE meta SET clean=NULL", "NATIVE_FORMAT_OR_LEASE"],
  ["UPDATE meta SET version=5", "NATIVE_FORMAT_OR_LEASE"],
  ["UPDATE baselines SET flags=4", "NATIVE_CHANGE_UNSUPPORTED"],
  ["UPDATE entries SET key='WRONG'", "NATIVE_NAMESPACE_INVALID"],
  ["UPDATE nodes SET reparse=x'01'", "NATIVE_NAMESPACE_INVALID"],
  ["UPDATE nodes SET info=x'10000000'", "NATIVE_CHANGE_UNSUPPORTED"],
  ["DELETE FROM entries", "NATIVE_NAMESPACE_INVALID"],
])("refuses uncertain metadata: %s", async (sql, error) => {
  const f = await fixture();
  f.mutate(sql);
  await expect(f.inspect()).rejects.toThrow(error);
});

it("rejects traversal, duplicates, excessive content, cancellation and hardlinked private objects", async () => {
  const f = await fixture();
  await expect(f.inspect(["../escape"])).rejects.toThrow("PATH_REJECTED");
  await expect(f.inspect(["edit.txt", "edit.txt"])).rejects.toThrow(
    "NATIVE_CHANGE_UNSUPPORTED",
  );
  await expect(f.inspect(["edit.txt"], AbortSignal.abort())).rejects.toThrow();
  const object = path.join(f.control, "objects", f.object);
  await writeFile(object, Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(f.inspect()).rejects.toThrow("FILE_TYPE_OR_LIMIT");
  await writeFile(object, "small");
  await link(object, path.join(f.control, "alias"));
  await expect(f.inspect()).rejects.toThrow("FILE_TYPE_OR_LIMIT");
});

it("rejects a captured ancestor instead of mapping child bytes onto a different directory", async () => {
  const f = await fixture();
  f.mutate(
    "UPDATE baselines SET path='\\DIR\\EDIT.TXT',name='\\dir\\edit.txt'; INSERT INTO baselines VALUES('\\DIR','\\dir',2,'','',16,2)",
  );
  await expect(f.inspect(["dir/edit.txt"])).rejects.toThrow(
    "NATIVE_ANCESTOR_CHANGE_UNSUPPORTED",
  );
});

it("cleans metadata snapshots on rejection and refuses storing them inside the original view", async () => {
  const f = await fixture();
  f.mutate("UPDATE meta SET clean=NULL");
  await expect(f.inspect()).rejects.toThrow("NATIVE_FORMAT_OR_LEASE");
  expect(
    await readdir(path.join(path.dirname(f.control), "snapshots")),
  ).toEqual([]);
  await expect(
    readInterruptedFiles(
      f.source,
      await sourceIdentity(f.control),
      ["edit.txt"],
      new AbortController().signal,
      path.join(f.control, "snapshots"),
    ),
  ).rejects.toThrow("INSPECTION_DIRECTORY_INVALID");
});
