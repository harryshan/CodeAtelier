/**
 * Local v6 冻结 SQLite 与真实 B/O 文件测试夹具，供导出和完成态恢复单元回归使用。
 * 1. nativeFixture 创建隔离来源/控制目录及最小表结构；不模拟 WinFsp 的挂载和句柄行为。
 * 2. change 保存真实有界文件和修改映射，mutate 用于显式构造失效/收据/代次场景。
 * 3. 所有目录由 temp 管理，调用结束关闭 SQLite；真实挂载一致性另由手动 verifier 验证。
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { temp } from "./helpers.js";
import { sourceIdentity } from "../../src/local-overlays/publication/files.js";

export async function nativeFixture() {
  const root = await temp();
  const lower = path.join(root, "lower");
  const control = path.join(root, "control");
  await mkdir(lower);
  await mkdir(path.join(control, "baselines"), { recursive: true });
  await mkdir(path.join(control, "objects"));
  const source = await sourceIdentity(lower);
  const db = new DatabaseSync(path.join(control, "overlay.sqlite"));
  const seal = randomUUID();
  db.exec(`
    CREATE TABLE meta(version INTEGER,source TEXT,clean INTEGER);
    CREATE TABLE baselines(path TEXT,name TEXT,kind INTEGER,object TEXT,stamp TEXT,attributes INTEGER,flags INTEGER);
    CREATE TABLE sealed_changes(path TEXT,kind INTEGER,object TEXT);
    CREATE TABLE observations(path TEXT,name TEXT,epoch INTEGER DEFAULT 0);
    CREATE TABLE checked_reads(path TEXT,valid INTEGER,epoch INTEGER DEFAULT 0);
    CREATE TABLE change_epochs(path TEXT,epoch INTEGER);
    CREATE TABLE epoch_links(epoch INTEGER,dependency INTEGER);
    CREATE TABLE object_epochs(object TEXT,epoch INTEGER);
    CREATE TABLE local_state(epoch INTEGER,seal TEXT);
    CREATE TABLE acknowledgements(id TEXT PRIMARY KEY,epoch INTEGER,seal TEXT);
  `);
  db.prepare("INSERT INTO meta VALUES(6,?,0)").run(source.root);
  db.prepare("INSERT INTO local_state VALUES(0,?)").run(seal);
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
      update
        .prepare("INSERT INTO change_epochs VALUES(?,0)")
        .run(native.toUpperCase());
      if (ours !== null) {
        update.prepare("INSERT INTO object_epochs VALUES(?,0)").run(after);
      }
    } finally {
      update.close();
    }
  }

  return { source, control, change, mutate, seal };
}
