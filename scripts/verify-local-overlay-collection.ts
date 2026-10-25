/**
 * 手动验证冻结 Local overlay 的私有内容回收，使用真实 WinFsp/NTFS 和原生 Publisher。
 * 1. mount/inventory 在独占 .local 夹具创建视图，分别记录 lower 访问和私有内容逻辑字节。
 * 2. 每轮修改同一文件，先回收再发布；验证未确认检查点仍有效、确认后 B/O 可回收且重试幂等。
 * 3. 首轮故意中断确认并恢复，之后重放旧收据；未选产物、冲突 B/O 和读依赖始终保留。
 * 4. GUID 硬链接/目录/junction、未知文件均保留，正常孤立文件删除，不触碰其来源目标。
 * 5. 输出分轮计数/字节及限制，finally 等待所有 helper 正常关闭；不进默认 check 或 Evaluation。
 * 不安装驱动、修改服务/真实项目，逻辑字节不是分配簇大小，不清理历史 journal 或 SQLite 空闲页。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../src/logging/logger.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
  type OverlayAcknowledgement,
} from "../src/worktrees/overlay.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-collection-"));
const source = path.join(root, "source");
const control = path.join(root, "control");
await mkdir(source);
const mainContent = (round: number) =>
  `round ${round}\n` + "x".repeat(256 * 1024);
await writeFile(path.join(source, "main.txt"), mainContent(0));
await writeFile(path.join(source, "conflict.txt"), "base\n");
await writeFile(path.join(source, "guard.txt"), "must survive\n");
const identity = await sourceIdentity(source);
const id = randomUUID();
const workspace = overlayWorkspace(overlayNamespace(root), id);
const log = createLogger(root, "info");
const publisher = new Publisher(path.join(root, "publisher"), log);
const managers: OverlayManager[] = [];
let previous: OverlayAcknowledgement | undefined;
const rounds: unknown[] = [];

async function mount(create: boolean) {
  const manager = new OverlayManager(root, log);
  managers.push(manager);
  await manager.start(
    id,
    source,
    control,
    workspace,
    create,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );

  return manager;
}

async function inventory() {
  let count = 0;
  let bytes = 0;
  for (const directory of ["objects", "baselines"]) {
    for (const name of await readdir(path.join(control, directory))) {
      const info = await lstat(path.join(control, directory, name));
      if (info.isFile()) {
        count += 1;
        bytes += info.size;
      }
    }
  }

  return { count, bytes };
}

function rows(sql: string) {
  const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

try {
  const first = await mount(true);
  assert.deepEqual(await inventory(), { count: 0, bytes: 0 });
  const creation = await first.metrics(id);
  assert.equal(creation.lowerEnumerations, 0);
  await writeFile(path.join(workspace, "artifact.txt"), "a".repeat(128 * 1024));
  await writeFile(path.join(workspace, "conflict.txt"), "private\n");
  await mkdir(path.join(workspace, "directory"));
  await writeFile(
    path.join(workspace, "directory", "nested.txt"),
    "nested private\n",
  );
  await rename(
    path.join(workspace, "directory"),
    path.join(workspace, "renamed"),
  );

  for (let round = 1; round <= 5; round += 1) {
    const manager = round === 1 ? first : await mount(false);
    assert.equal(
      await readFile(path.join(workspace, "main.txt"), "utf8"),
      mainContent(round - 1),
    );
    assert.equal(
      await readFile(path.join(workspace, "artifact.txt"), "utf8"),
      "a".repeat(128 * 1024),
    );
    assert.equal(
      await readFile(path.join(workspace, "conflict.txt"), "utf8"),
      "private\n",
    );
    await writeFile(path.join(workspace, "main.txt"), mainContent(round));

    await manager.withFrozen(
      id,
      async (verify, acknowledge, signal, collect) => {
        if (previous) {
          await acknowledge(previous);
        }

        const batch = await nativeBatch(
          identity,
          control,
          ["main.txt"],
          verify,
        );
        const checkpoint = batch.checkpoint;
        const before = await inventory();
        const reads = rows("SELECT * FROM observations ORDER BY epoch,path");
        const pending = await collect();
        assert.equal(pending.removed, 0);
        assert.deepEqual(
          (await nativeBatch(identity, control, ["main.txt"], verify))
            .checkpoint,
          checkpoint,
        );
        assert.deepEqual(
          rows("SELECT * FROM observations ORDER BY epoch,path"),
          reads,
        );
        const published = await publisher.publish(batch, {
          nativeWindows: true,
          signal,
          validate: async (files) =>
            assert.equal(files.get("main.txt")?.toString(), mainContent(round)),
          refresh: {
            request: batch.acknowledgement,
            checkpoint,
            acknowledge: async (request) => {
              if (round === 1) {
                throw new Error("Simulated interruption before confirmation");
              }

              await acknowledge(request);
              if (round === 2) {
                throw new Error("Simulated receipt loss after confirmation");
              }
            },
          },
        });
        assert.equal(published.refreshPending, round <= 2);
        if (round === 1) {
          assert.equal((await collect()).removed, 0);
          await publisher.recoverRefresh(batch, control, acknowledge, {
            signal,
          });
        }

        const collected = await collect();
        assert.equal(collected.removed, 2);
        assert.equal(
          collected.bytes,
          Buffer.byteLength(mainContent(round - 1)) +
            Buffer.byteLength(mainContent(round)),
        );
        const after = await inventory();
        assert.equal(
          after.bytes,
          128 * 1024 + Buffer.byteLength("base\nprivate\nnested private\n"),
        );
        assert.equal(after.count, 4);
        assert.equal((await collect()).removed, 0);
        if (round === 2) {
          // Recovery uses the durable acknowledgement, not deleted B/O files.
          await publisher.recoverRefresh(batch, control, acknowledge, {
            signal,
          });
        }

        await acknowledge(batch.acknowledgement);
        assert.deepEqual(
          rows("SELECT * FROM observations ORDER BY epoch,path"),
          reads,
        );
        previous = batch.acknowledgement;
        rounds.push({ round, before, collected, after });
      },
    );
    assert.equal(
      await readFile(path.join(source, "main.txt"), "utf8"),
      mainContent(round),
    );
  }

  // Deliberately malformed/orphan storage is only introduced inside this fixture.
  const orphan = path.join(control, "objects", `{${randomUUID()}}`);
  await writeFile(orphan, "orphan");
  const alias = path.join(control, "objects", `{${randomUUID()}}`);
  await link(path.join(source, "guard.txt"), alias);
  const directory = path.join(control, "objects", `{${randomUUID()}}`);
  await mkdir(directory);
  await writeFile(
    path.join(directory, "nested.txt"),
    "not recursively deleted",
  );
  const junction = path.join(control, "objects", `{${randomUUID()}}`);
  await symlink(source, junction, "junction");
  const unknown = path.join(control, "objects", "unknown-content");
  await writeFile(unknown, "preserve");
  const readonly = path.join(control, "objects", `{${randomUUID()}}`);
  await writeFile(readonly, "retry after release");
  await chmod(readonly, 0o444);
  await writeFile(path.join(source, "conflict.txt"), "external\n");
  const final = await mount(false);
  assert.equal(
    await readFile(path.join(workspace, "conflict.txt"), "utf8"),
    "private\n",
  );
  await final.withFrozen(id, async (verify, _acknowledge, signal, collect) => {
    await assert.rejects(
      nativeBatch(identity, control, ["conflict.txt"], verify),
      /STALE_DEPENDENCY/,
    );
    const references = rows("SELECT * FROM baselines ORDER BY path");
    const reads = rows("SELECT * FROM observations ORDER BY epoch,path");
    const result = await collect();
    assert.equal(result.removed, 1);
    assert.equal(result.bytes, 6);
    assert.equal(result.retained, 5);
    await assert.rejects(lstat(orphan), { code: "ENOENT" });
    assert.equal((await lstat(alias)).nlink, 2);
    assert.equal((await lstat(junction)).isSymbolicLink(), true);
    assert.equal(
      await readFile(path.join(directory, "nested.txt"), "utf8"),
      "not recursively deleted",
    );
    assert.equal(await readFile(unknown, "utf8"), "preserve");
    assert.deepEqual(rows("SELECT * FROM baselines ORDER BY path"), references);
    assert.deepEqual(
      rows("SELECT * FROM observations ORDER BY epoch,path"),
      reads,
    );
    signal.throwIfAborted();
    await assert.rejects(
      nativeBatch(identity, control, ["conflict.txt"], verify),
      /STALE_DEPENDENCY/,
    );
    assert.equal((await collect()).removed, 0);
    await chmod(readonly, 0o666);
    const retried = await collect();
    assert.equal(retried.removed, 1);
    assert.equal(retried.bytes, Buffer.byteLength("retry after release"));
    assert.equal(retried.retained, 4);
    assert.equal(
      await readFile(path.join(source, "conflict.txt"), "utf8"),
      "external\n",
    );
  });
  const resumed = await mount(false);
  assert.equal(
    await readFile(path.join(workspace, "conflict.txt"), "utf8"),
    "private\n",
  );
  assert.equal(
    await readFile(path.join(workspace, "artifact.txt"), "utf8"),
    "a".repeat(128 * 1024),
  );
  assert.equal(
    await readFile(path.join(workspace, "renamed", "nested.txt"), "utf8"),
    "nested private\n",
  );
  await assert.rejects(lstat(path.join(workspace, "directory")), {
    code: "ENOENT",
  });
  await resumed.close();
  assert.equal(
    await readFile(path.join(source, "guard.txt"), "utf8"),
    "must survive\n",
  );

  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    backend: "self-developed WinFsp Local overlay v6",
    creation,
    rounds,
    recovery:
      "pending confirmation retained B/O; lost confirmed receipt recovered after B/O collection; old receipt replay passed",
    retained:
      "unselected artifact, renamed directory content, conflict B/O, read epochs and receipts survived collection/remount",
    unsafeEntries:
      "hard link, directory, junction and unknown name retained; read-only orphan retained then retried; regular orphan removed",
    limitations: [
      "Host PoC, no product lifecycle or Sandbox automatic collection",
      "Logical content bytes only; SQLite free pages, observations, journals and receipts retained",
      "No power-loss or hostile-host proof; unclean views still refuse automatic restore",
    ],
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `LOCAL_OVERLAY_COLLECTION PASS report=${path.join(root, "report.json")}\n`,
  );
} finally {
  const results = await Promise.allSettled(
    managers.map((manager) => manager.close()),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}
