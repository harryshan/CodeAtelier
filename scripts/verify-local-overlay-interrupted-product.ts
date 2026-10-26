/**
 * 手动验证异常卷的生产 Service 检查/新参考会话链路，使用真实 WinFsp 和独占小目录。
 * 1. Service 创建真实视图，独立宿主恢复并产生部分写入；注入遗留 active 清单/服务锁模拟丢失收尾。
 * 2. 验证活动 helper/owner 均拒绝检查，自己的两个进程退出后才可检查选集和创建 v3 参考。
 * 3. 新视图读取最新 lower、保留部分材料，明确重新编辑并经候选回调发布；旧 dirty 卷/锁/清单不变。
 * 4. finally 只停止本脚本持有的进程/租约；保留报告，不操作用户项目、安装态、Sandbox 或 Evaluation。
 * 合成生命周期清单不等于真实服务崩溃或 Runtime 后代排空；HTTP/浏览器和安装态由独立回归覆盖。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import {
  LocalOverlayService,
  type LocalOverlayLease,
} from "../src/local-overlays/service.js";
import { resolutionDirectory } from "../src/local-overlays/resolution.js";
import type { Session } from "../src/shared/types.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-interrupted-product-"));
const source = path.join(root, "source");
const data = path.join(root, "data");
await mkdir(source);
await mkdir(data);
for (const name of ["edit.txt", "gone.txt", "partial.txt"]) {
  await writeFile(path.join(source, name), "original");
}

const log = createLogger(root, "info");
const service = new LocalOverlayService(data, log);
const sessions = new Map<string, Session>();
const bind = async (workspace: string) => {
  if (!sessions.has(workspace)) {
    sessions.set(workspace, { id: randomUUID(), workspace } as Session);
  }

  return sessions.get(workspace)!;
};

const id = randomUUID();
const parent = await service.create({ id, source }, bind);
const control = path.join(service.root, id);
const manifestPath = path.join(service.root, `${id}.json`);
const lockPath = path.join(service.root, `${id}.lock`);
const record = JSON.parse(await readFile(manifestPath, "utf8"));
record.phase = "active";
record.taskId = randomUUID();
await writeFile(manifestPath, JSON.stringify(record));
await writeFile(lockPath, "", { flag: "wx" });
const owner = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/fixtures/local-overlay-interrupted-owner.ts",
    root,
    control,
    parent.workspace,
  ],
  { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
);
const ownerClosed = once(owner, "close");
const signal = AbortSignal.timeout(120_000);
let helper = 0;
let lease: LocalOverlayLease | undefined;
try {
  const [ready] = await once(owner, "message", { signal });
  assert.equal(ready.state, "ready");
  helper = ready.helper;
  assert(Number.isSafeInteger(helper) && helper > 0 && helper !== process.pid);
  const paths = ["partial.txt", "gone.txt", "new.txt"];
  const inspect = () =>
    service.reviewInterrupted(parent.workspace, parent.id, paths, signal);
  await assert.rejects(inspect(), { code: "LOCAL_INSPECTION_UNCONFIRMED" });
  const stopped = once(owner, "message", { signal });
  owner.send("crash-helper");
  assert.equal((await stopped)[0].state, "helper-exited");
  helper = 0;
  await assert.rejects(inspect(), { code: "LOCAL_INSPECTION_UNCONFIRMED" });
  owner.kill();
  await ownerClosed;
  const preserved = [
    manifestPath,
    lockPath,
    path.join(control, "overlay.sqlite"),
    path.join(control, "overlay.sqlite-wal"),
    path.join(control, "mount.lock"),
  ];
  const readPreserved = () =>
    Promise.all(
      preserved.map(async (file) =>
        readFile(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return null;
          }

          throw error;
        }),
      ),
    );
  const before = await readPreserved();
  const review = await inspect();
  assert.equal(review.state, "interrupted");
  assert.equal(
    (await service.describe(parent)).localOverlay?.interruptedReview,
    true,
  );
  const input = {
    id: randomUUID(),
    workspace: parent.workspace,
    sessionId: parent.id,
    paths,
    state: "interrupted" as const,
    version: review.version,
  };
  await assert.rejects(
    service.continueResolution({ ...input, version: "0".repeat(64) }, bind),
    /材料已经改变/,
  );
  assert.equal(sessions.size, 1);
  // Current source is deliberately not part of an interrupted B/private review.
  // The new view must read it freshly, not mistake old bytes for a patch.
  await writeFile(path.join(source, "partial.txt"), "new source");
  const child = await service.continueResolution(input, bind);
  assert.equal((await service.continueResolution(input, bind)).id, child.id);
  assert.equal(sessions.size, 2);
  const taskId = randomUUID();
  lease = await service.begin(child.workspace, child.id, taskId, signal);
  assert(lease);
  const reference = path.join(child.workspace, resolutionDirectory(input.id));
  const material = JSON.parse(
    await readFile(path.join(reference, "manifest.json"), "utf8"),
  );
  assert.equal(material.version, 3);
  assert.equal(material.state, "interrupted");
  const partial = material.entries.find(
    (entry: { path: string }) => entry.path === "partial.txt",
  );
  assert.equal(
    await readFile(
      path.join(reference, partial.directory, "interrupted-private"),
      "utf8",
    ),
    "private prefix only",
  );
  assert.equal(
    await readFile(path.join(child.workspace, "partial.txt"), "utf8"),
    "new source",
  );
  assert.equal(
    await readFile(path.join(source, "partial.txt"), "utf8"),
    "new source",
  );
  await writeFile(
    path.join(child.workspace, "partial.txt"),
    "explicitly resolved",
  );
  let validated = false;
  await service.select(child.workspace, child.id, taskId, {
    paths: ["partial.txt"],
    validate: async (files) => {
      assert.equal(files.get("partial.txt")?.toString(), "explicitly resolved");
      validated = true;
    },
  });
  const result = await lease.finish("completed", true);
  lease = undefined;
  assert.equal(result.publication?.state, "published");
  assert(validated);
  assert.equal(
    await readFile(path.join(source, "partial.txt"), "utf8"),
    "explicitly resolved",
  );
  assert.deepEqual(await readPreserved(), before);
  await assert.rejects(
    service.begin(parent.workspace, parent.id, randomUUID(), signal),
  );
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(
      {
        passed: true,
        timestamp: new Date().toISOString(),
        selected: paths.length,
        referenceVersion: 3,
        currentLowerRead: true,
        explicitEditValidatedAndPublished: true,
        oldEvidenceUnchanged: true,
        oldViewRefused: true,
        fixedRequestIdempotent: true,
        limitations: [
          "Synthetic active manifest and service lock; real helper/owner crash",
          "Host trusted validation callback, not model or Sandbox",
          "No old volume remount or unknown source incident resolution",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_INTERRUPTED_PRODUCT PASS root=${root}\n`);
} finally {
  if (helper) {
    try {
      process.kill(helper);
    } catch {
      // Only the tracked fixture helper can be stopped here.
    }
  }

  owner.kill();
  await ownerClosed;
  await lease?.finish("failed", true).catch(() => {});
  await service.close();
}
