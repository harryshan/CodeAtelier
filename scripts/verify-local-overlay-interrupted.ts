/**
 * 手动验证真实 WinFsp 异常私有层的离线检查，不挂载旧 dirty 卷或恢复执行。
 * 1. 独立宿主夹具写入后保留文件句柄，分别终止 helper/宿主以验证真实 PID/创建时间门槛。
 * 2. 两者退出后检查覆盖/新建/删除/未完成字节，禁止旧封存结果或 clean 状态冒充已完成修改。
 * 3. 验证检查排他、取消/异常排空、遗留无证明拒绝及正常关闭后宿主仍活着的兼容路径。
 * 4. 所有故障仅针对脚本创建并持有的进程；保留夹具/报告，不安装驱动、不运行用户任务或 Evaluation。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../src/logging/logger.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { inspectInterruptedFiles } from "../src/local-overlays/interrupted-review.js";
import { withLocalInspection } from "../src/local-overlays/inspection-lease.js";
import { withInspectionDatabase } from "../src/local-overlays/inspection-database.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-interrupted-"));
const log = createLogger(root, "info");
const signal = AbortSignal.timeout(120_000);
const selected = ["edit.txt", "new.txt", "gone.txt", "partial.txt"];

async function scenario(clean: boolean) {
  const directory = path.join(root, clean ? "clean" : "interrupted");
  const sourcePath = path.join(directory, "source");
  const controlPath = path.join(directory, "control");
  await mkdir(sourcePath, { recursive: true });
  for (const name of ["edit.txt", "gone.txt", "partial.txt"]) {
    await writeFile(path.join(sourcePath, name), "original");
  }

  const source = await sourceIdentity(sourcePath);
  const owner = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/fixtures/local-overlay-interrupted-owner.ts",
      directory,
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const ownerClosed = once(owner, "close");
  let helper = 0;
  try {
    const [ready] = await once(owner, "message", { signal });
    assert.equal(ready.state, "ready");
    helper = ready.helper;
    assert(
      Number.isSafeInteger(helper) && helper > 0 && helper !== process.pid,
    );
    const control = await sourceIdentity(controlPath);
    const inspect = () =>
      inspectInterruptedFiles(source, control, selected, {
        signal,
        log,
        traceDirectory: path.join(root, "traces"),
      });
    await assert.rejects(inspect(), { code: "LOCAL_INSPECTION_UNCONFIRMED" });
    const stopped = once(owner, "message", { signal });
    owner.send(clean ? "stop-helper" : "crash-helper");
    assert.equal((await stopped)[0].state, "helper-exited");
    assert.throws(() => process.kill(helper, 0), { code: "ESRCH" });
    helper = 0;
    if (!clean) {
      await assert.rejects(inspect(), { code: "LOCAL_INSPECTION_UNCONFIRMED" });
      owner.kill();
      await ownerClosed;
    }

    const hash = async (file: string) =>
      createHash("sha256")
        .update(await readFile(path.join(controlPath, file)))
        .digest("hex");
    const before = {
      database: await hash("overlay.sqlite"),
      lease: await hash("mount.lock"),
    };
    const walBefore = await readFile(
      path.join(controlPath, "overlay.sqlite-wal"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
    const result = await inspect();
    assert.equal(result.state, "interrupted");
    assert.equal(result.publicationChecked, false);
    const content = (name: string, field: "base" | "private") => {
      const value = result.files.find((file) => file.path === name)![field]
        .content;

      return value === null ? null : Buffer.from(value, "base64").toString();
    };

    assert.equal(content("edit.txt", "base"), "original");
    assert.equal(content("edit.txt", "private"), "private complete");
    assert.equal(content("new.txt", "base"), null);
    assert.equal(content("new.txt", "private"), "private new");
    assert.equal(content("gone.txt", "private"), null);
    assert.equal(content("partial.txt", "private"), "private prefix only");
    await withLocalInspection(controlPath, signal, async () => {
      await assert.rejects(inspect(), { code: "LOCAL_INSPECTION_UNCONFIRMED" });
    });
    const cancellation = new AbortController();
    await assert.rejects(
      withLocalInspection(controlPath, cancellation.signal, async (current) => {
        cancellation.abort();
        current.throwIfAborted();
      }),
    );
    assert.deepEqual(await inspect(), result);
    const lock = await readFile(path.join(controlPath, "mount.lock"));
    await writeFile(path.join(controlPath, "mount.lock"), "");
    await assert.rejects(inspect(), { code: "LOCAL_INSPECTION_UNCONFIRMED" });
    await writeFile(path.join(controlPath, "mount.lock"), lock);
    assert.equal(await hash("overlay.sqlite"), before.database);
    assert.equal(await hash("mount.lock"), before.lease);
    const walAfter = await readFile(
      path.join(controlPath, "overlay.sqlite-wal"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
    assert.deepEqual(walAfter, walBefore);
    await withLocalInspection(controlPath, signal, () =>
      withInspectionDatabase(
        path.join(controlPath, "overlay.sqlite"),
        path.join(root, "traces", "snapshots"),
        signal,
        [sourcePath, controlPath],
        async (copy) => {
          const db = new DatabaseSync(copy, { readOnly: true });
          try {
            assert.equal(
              db.prepare("SELECT clean FROM meta").get()?.clean,
              clean ? 1 : 0,
            );
          } finally {
            db.close();
          }
        },
      ),
    );

    for (const name of ["edit.txt", "gone.txt", "partial.txt"]) {
      assert.equal(
        await readFile(path.join(sourcePath, name), "utf8"),
        "original",
      );
    }

    return {
      clean,
      files: result.files.length,
      state: result.state,
      sourceUnchanged: true,
      databaseAndLeaseUnchanged: true,
    };
  } finally {
    if (helper) {
      try {
        process.kill(helper);
      } catch {
        /* Already exited fixture only. */
      }
    }

    owner.kill();
    await ownerClosed;
  }
}

const interrupted = await scenario(false);
const clean = await scenario(true);
assert.deepEqual(await readdir(path.join(root, "traces", "snapshots")), []);
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(
    {
      passed: true,
      timestamp: new Date().toISOString(),
      interrupted,
      clean,
      checks: [
        "live helper refused",
        "active owner refused after helper exit",
        "dead owner and helper allow inspection",
        "current private bytes include interrupted prefix",
        "lease excludes concurrent inspector",
        "cancellation closes inspection",
        "missing legacy proof refused",
        "closed helper permits live owner inspection",
        "original database WAL and lease bytes unchanged",
        "temporary metadata snapshots cleaned after inspection",
      ],
      limitations: [
        "No old volume remount, private writes, publication or lock deletion",
        "No Runtime descendant drain claim or public recovery UI",
        "Partial private bytes are reference material, not completed edits",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`LOCAL_INTERRUPTED PASS root=${root}\n`);
