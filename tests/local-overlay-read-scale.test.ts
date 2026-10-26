/**
 * 工程规模读依赖的磁盘回归，由 Vitest 调用，不运行编译器、模型或原生挂载。
 * 1. 版本读取必须与既有完整快照相同，跨块、大文件和内容变化保持完整哈希语义。
 * 2. 只读版本放宽文件大小但保留类型/路径/取消边界，不能放宽源码发布正文限制。
 * 3. 主任务及候选冻结导出超过 100 条依赖，任意过期观察仍拒绝，Publisher 再检查后期变更。
 * 4. 数量与总字段预算有界；使用真实 SQLite/文件夹具，原生观察回执由替身生成。
 */
import { link, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { nativeFixture } from "./fixtures/local-overlay-native.js";
import {
  snapshot,
  snapshotVersion,
  sourceIdentity,
} from "../src/local-overlays/publication/files.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import {
  candidateReads,
  validateReceipt,
} from "../src/local-overlays/candidate-reads.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { EditSession } from "../src/local-overlays/publication/session.js";

it("streams identical content versions across chunks without extending the editable file limit", async () => {
  const root = await temp();
  const source = await sourceIdentity(root);
  const data = Buffer.alloc(200_000, 17);
  await writeFile(path.join(root, "file.bin"), data);
  expect(await snapshotVersion(source, "file.bin")).toBe(
    (await snapshot(source, "file.bin")).version,
  );
  expect(await snapshotVersion(source, "missing.bin")).toBe("missing");
  await writeFile(
    path.join(root, "large.bin"),
    Buffer.alloc(3 * 1024 * 1024, 29),
  );
  const before = await snapshotVersion(source, "large.bin");
  const file = await open(path.join(root, "large.bin"), "r+");
  try {
    await file.write(Buffer.from([30]), 0, 1, 2 * 1024 * 1024);
  } finally {
    await file.close();
  }

  expect(await snapshotVersion(source, "large.bin")).not.toBe(before);
  await expect(snapshot(source, "large.bin")).rejects.toThrow(
    "FILE_TYPE_OR_LIMIT",
  );
  await expect(snapshotVersion(source, "../escape")).rejects.toThrow();
  await mkdir(path.join(root, "directory"));
  await expect(snapshotVersion(source, "directory")).rejects.toThrow(
    "FILE_TYPE_OR_LIMIT",
  );
  await expect(
    snapshotVersion(
      source,
      "file.bin",
      AbortSignal.abort(new Error("cancelled")),
    ),
  ).rejects.toThrow("cancelled");

  const oversized = await open(path.join(root, "oversized.bin"), "wx");
  try {
    await oversized.truncate(256 * 1024 * 1024 + 1);
  } finally {
    await oversized.close();
  }

  await expect(snapshotVersion(source, "oversized.bin")).rejects.toThrow(
    "FILE_TYPE_OR_LIMIT",
  );
});

it("rejects an excessive native read set before reading any missing dependencies", async () => {
  const f = await nativeFixture();
  await f.change("code.txt", "old", "new");
  f.mutate(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO observations SELECT '\\DEP-'||x, '\\dep-'||x, 0 FROM n;`);
  await expect(
    nativeBatch(f.source, f.control, ["code.txt"], async () => {}),
  ).rejects.toThrow("READ_LIMIT");
  await expect(
    candidateReads(
      f.source,
      f.control,
      new Map([["code.txt", Buffer.from("new")]]),
      async () => {},
    ),
  ).rejects.toThrow("READ_LIMIT");
});

it("exports a compiler-sized dependency set and still rejects a stale observation", async () => {
  const f = await nativeFixture();
  await f.change("code.txt", "old", "new");
  let sql = "";
  for (let index = 0; index < 128; index++) {
    await writeFile(
      path.join(f.source.root, `dep-${index}.txt`),
      `dependency ${index}`,
    );
    sql += `INSERT INTO observations VALUES('\\DEP-${index}.TXT','\\dep-${index}.txt',0);`;
  }

  f.mutate(sql);
  const verify = async () => {
    f.mutate(
      "DELETE FROM checked_reads; INSERT INTO checked_reads SELECT path,1,epoch FROM observations;",
    );
  };

  const batch = await nativeBatch(f.source, f.control, ["code.txt"], verify);
  expect(batch.reads).toHaveLength(128);
  const receipt = await candidateReads(
    f.source,
    f.control,
    new Map([["code.txt", Buffer.from("new")]]),
    verify,
  );
  expect(receipt.reads).toHaveLength(128);
  await expect(
    nativeBatch(f.source, f.control, ["code.txt"], async () => {
      await verify();
      f.mutate("UPDATE checked_reads SET valid=0 WHERE path='\\DEP-127.TXT'");
    }),
  ).rejects.toThrow("STALE_DEPENDENCY");
});

it("versions package-manager hardlinks without allowing their source publication", async () => {
  const root = await temp();
  const source = await sourceIdentity(root);
  await writeFile(path.join(root, "dependency.txt"), "original");
  await link(path.join(root, "dependency.txt"), path.join(root, "alias.txt"));
  const before = await snapshotVersion(source, "dependency.txt");
  await expect(snapshot(source, "dependency.txt")).rejects.toThrow(
    "FILE_TYPE_OR_LIMIT",
  );
  await writeFile(path.join(root, "alias.txt"), "modified");
  expect(await snapshotVersion(source, "dependency.txt")).not.toBe(before);
});

it("deduplicates content hashing without dropping an older epoch observation", async () => {
  const f = await nativeFixture();
  await f.change("code.txt", "old", "new");
  await writeFile(path.join(f.source.root, "dep.txt"), "dependency");
  f.mutate(`UPDATE local_state SET epoch=1;
    INSERT INTO observations VALUES('\\DEP.TXT','\\dep.txt',0),('\\DEP.TXT','\\dep.txt',1);
    INSERT INTO checked_reads VALUES('\\DEP.TXT',1,0),('\\DEP.TXT',1,1);`);
  const batch = await nativeBatch(
    f.source,
    f.control,
    ["code.txt"],
    async () => {},
  );
  expect(batch.reads).toHaveLength(1);
  f.mutate("UPDATE checked_reads SET valid=0 WHERE epoch=0");
  await expect(
    nativeBatch(f.source, f.control, ["code.txt"], async () => {}),
  ).rejects.toThrow("STALE_DEPENDENCY");
});

it("retains enlarged receipt budgets and rechecks large dependencies before source publication", async () => {
  expect(() =>
    validateReceipt({
      reads: Array.from({ length: 10001 }, (_, index) => ({
        path: `${index}`,
        version: "v",
      })),
    }),
  ).toThrow();
  expect(() =>
    validateReceipt({
      reads: Array.from({ length: 5000 }, (_, index) => ({
        path: `${index}` + "a".repeat(900),
        version: "v",
      })),
    }),
  ).toThrow();
  const root = await temp();
  const directory = path.join(root, "source");
  await mkdir(directory);
  const source = await sourceIdentity(directory);
  await writeFile(path.join(directory, "code.txt"), "old");
  await writeFile(
    path.join(directory, "large.bin"),
    Buffer.alloc(3 * 1024 * 1024, 17),
  );
  const edit = new EditSession(source);
  await edit.read("code.txt");
  await edit.edit("code.txt", Buffer.from("new"));
  const version = await snapshotVersion(source, "large.bin");
  await expect(
    new Publisher(path.join(root, "publisher")).publish(edit.seal(), {
      validate: async () => {
        await writeFile(path.join(directory, "large.bin"), "changed");

        return { reads: [{ path: "large.bin", version }] };
      },
    }),
  ).rejects.toThrow("STALE_VALIDATION_DEPENDENCY");
  expect(await readFile(path.join(directory, "code.txt"), "utf8")).toBe("old");
});
