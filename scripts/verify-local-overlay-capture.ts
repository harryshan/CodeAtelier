/**
 * 手动验证 Local WinFsp 自动基线捕获；不预先声明编辑路径、不调用 EditSession.read。
 * 1. 建立独占普通目录和 Local 挂载，检查启动无 lower 遍历、无内容对象。
 * 2. 通过真实文件 API 执行读、覆盖、临时替换、删除、重命名和二进制写入。
 * 3. 注入来源读后变化，确认写入/删除/替换被拒绝且私有修改可继续读取。
 * 4. 原生 freeze 停止挂载并保留租约，只读检查封存结果及不可变原文；重挂载验证持久性。
 * 仅使用已安装 helper/WinFsp 和本脚本夹具；不发布来源、不安装驱动、不运行 Evaluation。
 * 记录捕获事实，不宣称完成变化集导出、发布确认、跨文件快照或产品生命周期。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createLogger } from "../src/logging/logger.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/local-overlays/winfsp-manager.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";

assert.equal(process.platform, "win32", "Requires native Windows and WinFsp");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-capture-"));
const source = path.join(root, "source");
const control = path.join(root, "control");
await mkdir(source);
const original = new Map<string, Buffer>([
  ["edit.txt", Buffer.from("original edit\n")],
  ["replace.txt", Buffer.from("original replace\n")],
  ["delete.txt", Buffer.from("original delete\n")],
  ["rename.txt", Buffer.from("original rename\n")],
  ["stale.txt", Buffer.from("old version\n")],
  ["stale-delete.txt", Buffer.from("old version\n")],
  ["stale-replace.txt", Buffer.from("old version\n")],
  ["stale-metadata.txt", Buffer.from("old version\n")],
  ["binary.bin", Buffer.from([0, 255, 13, 10, 128])],
]);
for (const [name, bytes] of original) {
  await writeFile(path.join(source, name), bytes);
}

const log = createLogger(root, "info");
let manager = new OverlayManager(root, log);
const id = randomUUID();
const workspace = overlayWorkspace(overlayNamespace(root), id);
const mounted = (name: string) => path.join(workspace, name);

async function mount(create: boolean) {
  await manager.start(
    id,
    source,
    control,
    workspace,
    create,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );
}

async function inspect() {
  const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = db
      .prepare(
        "SELECT name,kind,object,stamp,flags FROM baselines ORDER BY name",
      )
      .all();
    const byName = new Map(rows.map((row) => [row.name as string, row]));
    for (const name of [
      "edit.txt",
      "replace.txt",
      "delete.txt",
      "rename.txt",
      "binary.bin",
      "stale-metadata.txt",
    ]) {
      const row = byName.get(`\\${name}`);
      assert.ok(row, `Missing automatic baseline: ${name}`);
      assert.equal(row.kind, 1);
      assert.deepEqual(
        await readFile(path.join(control, "baselines", row.object as string)),
        original.get(name),
      );
    }

    for (const name of [".replace.tmp", "renamed.txt", "new.txt", "gone.txt"]) {
      const row = byName.get(`\\${name}`);
      assert.ok(row, `Missing absence baseline: ${name}`);
      assert.equal(row.kind, 0);
      assert.equal(row.object, "");
    }

    for (const name of ["stale.txt", "stale-delete.txt", "stale-replace.txt"]) {
      assert.equal(byName.has(`\\${name}`), false);
    }

    assert.ok(
      db
        .prepare("SELECT path FROM observations WHERE name=?")
        .get("\\edit.txt"),
    );

    return rows.length;
  } finally {
    db.close();
  }
}

try {
  await mount(true);
  const initial = await manager.metrics(id);
  assert.equal(initial.lowerOpens, 0);
  assert.equal(initial.lowerEnumerations, 0);
  assert.deepEqual(await readdir(path.join(control, "baselines")), []);
  assert.deepEqual(await readdir(path.join(control, "objects")), []);

  for (const [name, bytes] of original) {
    assert.deepEqual(await readFile(mounted(name)), bytes);
  }

  // Actual reads record stamps, but never copy source contents into control.
  assert.deepEqual(await readdir(path.join(control, "baselines")), []);
  assert.deepEqual(await readdir(path.join(control, "objects")), []);
  await writeFile(mounted("edit.txt"), "private edit\n");
  await writeFile(mounted(".replace.tmp"), "private replacement\n");
  await rename(mounted(".replace.tmp"), mounted("replace.txt"));
  await unlink(mounted("delete.txt"));
  await rename(mounted("rename.txt"), mounted("renamed.txt"));
  await writeFile(mounted("new.txt"), "new private\n");
  await writeFile(mounted("gone.txt"), "temporary\n");
  await unlink(mounted("gone.txt"));
  await writeFile(mounted("binary.bin"), Buffer.from([255, 0, 128]));

  // Unlike utimes (which intentionally pins file bytes), an attribute-only
  // mutation captures B without promoting the live lower content to upper.
  await promisify(execFile)(
    "attrib.exe",
    ["+H", mounted("stale-metadata.txt")],
    {
      windowsHide: true,
      timeout: 10_000,
    },
  );
  await writeFile(path.join(source, "stale-metadata.txt"), "new version\n");
  await assert.rejects(
    writeFile(mounted("stale-metadata.txt"), "unsafe overwrite\n"),
  );

  for (const name of ["stale.txt", "stale-delete.txt", "stale-replace.txt"]) {
    const file = path.join(source, name);
    const before = await stat(file);
    await writeFile(file, "new version\n");
    // Restore LastWriteTime and length: NTFS ChangeTime must still reject it.
    await utimes(file, before.atime, before.mtime);
  }

  await assert.rejects(writeFile(mounted("stale.txt"), "unsafe overwrite\n"));
  await assert.rejects(unlink(mounted("stale-delete.txt")));
  await writeFile(mounted(".stale.tmp"), "unsafe replacement\n");
  await assert.rejects(
    rename(mounted(".stale.tmp"), mounted("stale-replace.txt")),
  );
  assert.equal(
    await readFile(mounted(".stale.tmp"), "utf8"),
    "unsafe replacement\n",
  );
  assert.equal(await readFile(mounted("edit.txt"), "utf8"), "private edit\n");
  for (const [name, bytes] of original) {
    if (!name.startsWith("stale")) {
      assert.deepEqual(await readFile(path.join(source, name)), bytes);
    }
  }

  // An already-private edit retains its original B, even after lower changes.
  await writeFile(path.join(source, "edit.txt"), "external next version\n");
  await writeFile(mounted("edit.txt"), "private second edit\n");
  const capturedPaths = await manager.withFrozen(id, async (verifyReads) => {
    await assert.rejects(readFile(mounted("edit.txt")));
    const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
      readOnly: true,
    });
    try {
      const rows = db.prepare("SELECT * FROM sealed_changes").all();
      assert.equal(rows.length, await inspect());
      for (const name of [
        "delete.txt",
        "rename.txt",
        ".replace.tmp",
        "gone.txt",
      ]) {
        assert.equal(
          rows.find((row) => row.path === `\\${name.toUpperCase()}`)?.kind,
          0,
        );
      }

      const edit = rows.find((row) => row.path === "\\EDIT.TXT");
      assert.equal(edit?.kind, 1);
      assert.equal(
        await readFile(
          path.join(control, "objects", edit!.object as string),
          "utf8",
        ),
        "private second edit\n",
      );
      await assert.rejects(
        nativeBatch(
          await sourceIdentity(source),
          control,
          ["edit.txt"],
          verifyReads,
        ),
        { message: "STALE_DEPENDENCY" },
      );
      const contender = new OverlayManager(root, log);
      await assert.rejects(
        contender.start(
          id,
          source,
          control,
          workspace,
          false,
          AbortSignal.timeout(30_000),
          { kind: "local" },
        ),
      );
      await assert.rejects(contender.close());

      return rows.length;
    } finally {
      db.close();
    }
  });
  manager = new OverlayManager(root, log);
  await mount(false);
  assert.equal(
    await readFile(mounted("edit.txt"), "utf8"),
    "private second edit\n",
  );
  assert.equal(
    await readFile(mounted("replace.txt"), "utf8"),
    "private replacement\n",
  );
  assert.deepEqual(
    await readFile(mounted("renamed.txt")),
    original.get("rename.txt"),
  );
  await assert.rejects(readFile(mounted("delete.txt")));
  await manager.close();
  assert.equal(await inspect(), capturedPaths);
  const reportFile = path.join(root, "report.json");
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        release: os.release(),
        initialLowerOpensExcludingRootIdentity: 0,
        initialLowerEnumerations: 0,
        initialContentObjects: 0,
        contentObjectsAfterReadOnlyAccess: 0,
        capturedPaths,
        operations: "overwrite, replace, delete, rename, create/delete, binary",
        staleReadWithRestoredMtime: "write/delete/replace rejected",
        sourceWriteIsolation: "passed",
        immutableBaselinesAndCleanRemount: "passed",
        frozenExport:
          "volume unavailable; sealed results readable; competing owner rejected",
        staleUnselectedRead: "native batch rejected before publication",
        limitations: [
          "This script only checks batch rejection; no epoch reset or publication acknowledgement yet",
          "No arbitrary directory/reparse publication or cryptographic read fingerprint",
          "Windows host file API test; not product/Sandbox lifecycle validation",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_OVERLAY_CAPTURE PASS report=${reportFile}\n`);
} finally {
  await manager.close();
}
