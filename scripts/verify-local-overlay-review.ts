/**
 * 手动验证生产 LocalOverlayService 的真实 WinFsp 私有修改检查。
 * 1. 独占普通来源目录，实际创建/编辑/排空；不使用 Git、模型或 Sandbox 替身。
 * 2. 来源后来修改后，离线检查 B/O/T 冲突和合并；复核数据库/清单字节不变。
 * 3. 再挂载继续编辑，确认检查未清除私有修改或阻塞续轮，结果写入独占证据目录。
 * 只操作本脚本夹具；无需 Repair，不安装驱动/重启服务，不进入默认检查或 Evaluation。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import {
  LocalOverlayService,
  type LocalOverlayLease,
} from "../src/local-overlays/service.js";
import type { Session } from "../src/shared/types.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-review-"));
const source = path.join(root, "source");
const data = path.join(root, "data");
await mkdir(source);
await mkdir(data);
await writeFile(path.join(source, "conflict.txt"), "base\n");
await writeFile(path.join(source, "merge.txt"), "first\nsecond\nthird\n");
const service = new LocalOverlayService(data, createLogger(root, "info"));
const id = randomUUID();
const sessionId = randomUUID();
const signal = AbortSignal.timeout(120_000);
let lease: LocalOverlayLease | undefined;
try {
  const session = await service.create(
    { id, source },
    async (workspace) =>
      ({
        id: sessionId,
        workspace,
      }) as Session,
  );
  lease = await service.begin(
    session.workspace,
    sessionId,
    randomUUID(),
    signal,
  );
  assert(lease);
  await writeFile(path.join(session.workspace, "conflict.txt"), "private\n");
  await writeFile(
    path.join(session.workspace, "merge.txt"),
    "private\nsecond\nthird\n",
  );
  await assert.rejects(
    service.review(session.workspace, sessionId, "conflict.txt", signal),
  );
  await lease.finish("failed", true);
  lease = undefined;
  await writeFile(path.join(source, "conflict.txt"), "external\n");
  await writeFile(path.join(source, "merge.txt"), "first\nsecond\nexternal\n");

  const database = path.join(service.root, id, "overlay.sqlite");
  const manifest = path.join(service.root, `${id}.json`);
  const beforeDatabase = await readFile(database);
  const beforeManifest = await readFile(manifest);
  const started = performance.now();
  const conflict = await service.review(
    session.workspace,
    sessionId,
    "conflict.txt",
    signal,
  );
  const merged = await service.review(
    session.workspace,
    sessionId,
    "merge.txt",
    signal,
  );
  const reviewMs = performance.now() - started;
  assert.equal(
    Buffer.from(conflict.base.content!, "base64").toString(),
    "base\n",
  );
  assert.equal(
    Buffer.from(conflict.ours.content!, "base64").toString(),
    "private\n",
  );
  assert.equal(
    Buffer.from(conflict.current.content!, "base64").toString(),
    "external\n",
  );
  assert.deepEqual(conflict.preview, {
    state: "conflict",
    reason: "TEXT_CONFLICT",
  });
  assert.deepEqual(merged.preview, {
    state: "merged",
    content: Buffer.from("private\nsecond\nexternal\n").toString("base64"),
  });
  assert.equal(conflict.publicationChecked, false);
  assert.deepEqual(await readFile(database), beforeDatabase);
  assert.deepEqual(await readFile(manifest), beforeManifest);

  lease = await service.begin(
    session.workspace,
    sessionId,
    randomUUID(),
    signal,
  );
  assert(lease);
  assert.equal(
    await readFile(path.join(session.workspace, "conflict.txt"), "utf8"),
    "private\n",
  );
  await writeFile(
    path.join(session.workspace, "conflict.txt"),
    "later private\n",
  );
  await lease.finish("cancelled", true);
  lease = undefined;
  const later = await service.review(
    session.workspace,
    sessionId,
    "conflict.txt",
    signal,
  );
  assert.notEqual(later.version, conflict.version);
  assert.equal(
    Buffer.from(later.ours.content!, "base64").toString(),
    "later private\n",
  );
  assert.equal(
    await readFile(path.join(source, "conflict.txt"), "utf8"),
    "external\n",
  );
  const report = path.join(root, "report.json");
  await writeFile(
    report,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        release: os.release(),
        passed: true,
        reviewMs,
        checks: [
          "active refusal",
          "B/O/T conflict",
          "merged preview",
          "database and manifest unchanged",
          "remount and edit",
          "version change",
          "source unchanged",
        ],
        limitations: [
          "Host fixture, not Sandbox or IPC v18 evidence",
          "Read-only service; no conflict resolution or UI",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_REVIEW PASS report=${report}\n`);
} finally {
  try {
    await lease?.finish("cancelled", true);
  } finally {
    await service.close();
  }
}
