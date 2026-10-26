/**
 * 手动验证 Local no-atime 的读开销和语义，使用真实 WinFsp 与独占普通目录。
 * 1. 在私有文件显式设定时间，重复读取必须保留该时间且不产生 SQLite 写入。
 * 2. 第二次显式改时间仍须持久化；普通 lower 保持实时读取，旧观察版本仍会标记失效。
 * 3. 干净卸载重挂载核对私有时间/内容保留，所有自身挂载在 finally 关闭，报告留在夹具中。
 * 不发布用户文件、安装驱动或运行 Sandbox/模型/Evaluation；不推导完整工程性能或依赖隔离。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../src/logging/logger.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-read-cost-"));
const source = path.join(root, "source");
const control = path.join(root, "control");
await mkdir(source);
await writeFile(path.join(source, "dep.txt"), "old dependency");
const log = createLogger(root, "info");
const id = randomUUID();
const workspace = overlayWorkspace(overlayNamespace(root), id);
const managers: OverlayManager[] = [];
const signal = AbortSignal.timeout(60_000);

async function mount(create: boolean) {
  const manager = new OverlayManager(root, log);
  managers.push(manager);
  await manager.start(id, source, control, workspace, create, signal, {
    kind: "local",
  });

  return manager;
}

try {
  const manager = await mount(true);
  const file = path.join(workspace, "private.txt");
  await writeFile(file, "private content");
  const first = new Date("2010-01-02T03:04:05.000Z");
  await utimes(file, first, first);
  const before = await manager.metrics(id);

  for (let index = 0; index < 20; index++) {
    assert.equal(await readFile(file, "utf8"), "private content");
  }

  const after = await manager.metrics(id);
  assert.equal(
    (await stat(file)).atimeMs,
    first.getTime(),
    "Reads must not replace explicit atime",
  );
  assert.equal(
    after.sqlWrites,
    before.sqlWrites,
    "Repeated private reads must not write SQLite",
  );
  assert(
    (after.accessCleanups ?? 0) > (before.accessCleanups ?? 0),
    "Must exercise access cleanup callbacks",
  );

  const second = new Date("2011-02-03T04:05:06.000Z");
  await utimes(file, second, second);
  assert.equal((await stat(file)).atimeMs, second.getTime());
  assert((await manager.metrics(id)).sqlWrites! > after.sqlWrites!);

  assert.equal(
    await readFile(path.join(workspace, "dep.txt"), "utf8"),
    "old dependency",
  );
  await writeFile(path.join(source, "dep.txt"), "new dependency");
  assert.equal(
    await readFile(path.join(workspace, "dep.txt"), "utf8"),
    "new dependency",
  );

  await manager.withFrozen(id, async (verify) => {
    await verify([0]);
    const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db
          .prepare("SELECT valid FROM checked_reads WHERE path=? AND epoch=0")
          .get("\\DEP.TXT")?.valid,
        0,
      );
    } finally {
      db.close();
    }
  });

  const restored = await mount(false);
  assert.equal((await stat(file)).atimeMs, second.getTime());
  assert.equal(await readFile(file, "utf8"), "private content");
  await restored.close();

  const report = path.join(root, "report.json");
  await writeFile(
    report,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        passed: true,
        before,
        after,
        checks: [
          "no automatic atime persistence",
          "explicit times preserved across restore",
          "zero SQLite writes for repeated private reads",
          "live lower changed content visible and stale observation rejected",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_READ_COST PASS report=${report}\n`);
} finally {
  for (const manager of managers) {
    await manager.close();
  }
}
