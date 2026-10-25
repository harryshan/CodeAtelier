/**
 * 冻结结果到发布批次的真实 SQLite/文件回归，不模拟 WinFsp 挂载语义。
 * 1. 夹具写入 v4 私有表、不可变原文与结果对象，确认来源变更不会被当成旧基线。
 * 2. 校验显式选择、空变更、重复路径、目录/属性/对象越界与只读依赖失效。
 * 3. verifyReads 夹具只生成原生结果表；真实句柄与复核协议由手动 --native/capture 脚本验证。
 * 不写用户文件、不运行发布或模型；测试资源由现有 temp 管理。
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { sourceIdentity } from "../scripts/local-overlay/files.js";
import { nativeBatch } from "../scripts/local-overlay/native-batch.js";

async function fixture() {
  const root = await temp();
  const lower = path.join(root, "lower");
  const control = path.join(root, "control");
  await mkdir(lower);
  await mkdir(path.join(control, "baselines"), { recursive: true });
  await mkdir(path.join(control, "objects"));
  const source = await sourceIdentity(lower);
  const db = new DatabaseSync(path.join(control, "overlay.sqlite"));
  db.exec(`
    CREATE TABLE meta(version INTEGER,source TEXT,clean INTEGER);
    CREATE TABLE baselines(path TEXT,name TEXT,kind INTEGER,object TEXT,stamp TEXT,attributes INTEGER,flags INTEGER);
    CREATE TABLE sealed_changes(path TEXT,kind INTEGER,object TEXT);
    CREATE TABLE observations(path TEXT,name TEXT);
    CREATE TABLE checked_reads(path TEXT,valid INTEGER);
  `);
  db.prepare("INSERT INTO meta VALUES(4,?,0)").run(source.root);
  db.close();

  function mutate(sql: string) {
    const update = new DatabaseSync(path.join(control, "overlay.sqlite"));
    try {
      update.exec(sql);
    } finally {
      update.close();
    }
  }

  async function change(
    name: string,
    base: string | null,
    ours: string | null,
  ) {
    const before = base === null ? "" : `{${randomUUID()}}`;
    const after = ours === null ? "" : `{${randomUUID()}}`;
    if (base !== null) {
      await writeFile(path.join(control, "baselines", before), base);
    }

    if (ours !== null) {
      await writeFile(path.join(control, "objects", after), ours);
    }

    const update = new DatabaseSync(path.join(control, "overlay.sqlite"));
    try {
      const native = `\\${name}`;
      update
        .prepare("INSERT INTO baselines VALUES(?,?,?,?,?,32,1)")
        .run(
          native.toUpperCase(),
          native,
          base === null ? 0 : 1,
          before,
          "original-stamp",
        );
      update
        .prepare("INSERT INTO sealed_changes VALUES(?,?,?)")
        .run(native.toUpperCase(), ours === null ? 0 : 1, after);
    } finally {
      update.close();
    }
  }

  return { source, control, change, mutate };
}

it("exports only selected B/O without substituting the latest lower for B", async () => {
  const f = await fixture();
  await f.change("code.txt", "old\n", "ours\n");
  await f.change("artifact.txt", null, "unselected\n");
  await f.change("gone.txt", null, null);
  await writeFile(path.join(f.source.root, "code.txt"), "new lower\n");
  const batch = await nativeBatch(
    f.source,
    f.control,
    ["code.txt", "gone.txt"],
    async () => {},
  );
  expect(batch.changes).toHaveLength(1);
  expect(batch.changes[0]?.path).toBe("code.txt");
  expect(
    Buffer.from(batch.changes[0]!.base.content!, "base64").toString(),
  ).toBe("old\n");
  expect(Buffer.from(batch.changes[0]!.ours!, "base64").toString()).toBe(
    "ours\n",
  );
});

it("keeps selected but unchanged files as dependencies and rejects stale reads", async () => {
  const f = await fixture();
  await f.change("code.txt", "old\n", "ours\n");
  await f.change("dep.txt", "same\n", "same\n");
  await writeFile(path.join(f.source.root, "dep.txt"), "same\n");
  f.mutate("INSERT INTO observations VALUES('\\DEP.TXT','\\dep.txt')");
  const verify = async () => {
    f.mutate("INSERT INTO checked_reads VALUES('\\DEP.TXT',1)");
  };

  const batch = await nativeBatch(
    f.source,
    f.control,
    ["code.txt", "dep.txt"],
    verify,
  );
  expect(batch.reads.map((read) => read.path)).toEqual(["dep.txt"]);
  await expect(
    nativeBatch(f.source, f.control, ["code.txt"], async () => {
      f.mutate("UPDATE checked_reads SET valid=0");
    }),
  ).rejects.toThrow("STALE_DEPENDENCY");
});

it.each([
  ["UPDATE baselines SET kind=2", "NATIVE_CHANGE_UNSUPPORTED"],
  ["UPDATE baselines SET flags=4", "NATIVE_CHANGE_UNSUPPORTED"],
  ["UPDATE sealed_changes SET kind=4", "NATIVE_CHANGE_UNSUPPORTED"],
  ["UPDATE baselines SET object='../escape'", "NATIVE_OBJECT_INVALID"],
  ["UPDATE meta SET clean=1", "NATIVE_FORMAT_OR_LEASE"],
])("rejects unpublishable frozen state: %s", async (sql, error) => {
  const f = await fixture();
  await f.change("code.txt", "old\n", "ours\n");
  f.mutate(sql);
  await expect(
    nativeBatch(f.source, f.control, ["code.txt"], async () => {}),
  ).rejects.toThrow(error);
});

it("rejects duplicate selected paths and .git publication", async () => {
  const f = await fixture();
  await f.change("code.txt", "old\n", "ours\n");
  await expect(
    nativeBatch(f.source, f.control, ["code.txt", "CODE.txt"], async () => {}),
  ).rejects.toThrow("DUPLICATE_PATH");
  await expect(
    nativeBatch(f.source, f.control, [".git/config"], async () => {}),
  ).rejects.toThrow("PATH_REJECTED");
});

it("rejects a selected child beneath an unselected directory change", async () => {
  const f = await fixture();
  await f.change("moved\\code.txt", "old\n", "ours\n");
  f.mutate(
    "INSERT INTO baselines VALUES('\\MOVED','\\moved',2,'','directory-stamp',16,2)",
  );
  await expect(
    nativeBatch(f.source, f.control, ["moved/code.txt"], async () => {}),
  ).rejects.toThrow("NATIVE_ANCESTOR_CHANGE_UNSUPPORTED");
});

it("uses native folded ancestor keys across non-ASCII name casing", async () => {
  const f = await fixture();
  await f.change("MÖVED\\code.txt", "old\n", "ours\n");
  f.mutate(
    "INSERT INTO baselines VALUES('\\MÖVED','\\möved',2,'','directory-stamp',16,2)",
  );
  await expect(
    nativeBatch(f.source, f.control, ["MÖVED/code.txt"], async () => {}),
  ).rejects.toThrow("NATIVE_ANCESTOR_CHANGE_UNSUPPORTED");
});
