/**
 * 手动验证保留旧私有修改、建立新 Local 对话并重新编辑/发布的真实 WinFsp 流程。
 * 1. 旧视图读取依赖并产生私有修改，外部更新来源后检查旧 B/O/T。
 * 2. 固定请求建立新视图及少量参考，验证新视图的源码来自当前来源、旧依赖不被修改。
 * 3. 显式重新读取依赖/编辑，候选以独立 Node 夹具执行后通过生产发布链路写回；旧视图仍完整保留。
 * 仅使用本脚本独占目录和宿主验证进程，不运行模型/Sandbox，不安装/Repair，不属于 Evaluation。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../src/logging/logger.js";
import {
  LocalOverlayService,
  type LocalOverlayLease,
} from "../src/local-overlays/service.js";
import { resolutionDirectory } from "../src/local-overlays/resolution.js";
import type { Session } from "../src/shared/types.js";

assert.equal(process.platform, "win32");
const execute = promisify(execFile);
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-resolution-"));
const source = path.join(root, "source");
const data = path.join(root, "data");
await mkdir(source);
await mkdir(data);
const base = "export const value = 1;\n";
const oldPrivate = "export const value = 10;\n";
const external = "export const value = 2;\n";
const resolved = "export const value = 30;\n";
await writeFile(path.join(source, "module.mjs"), base);
await writeFile(path.join(source, "dependency.txt"), "1");
const service = new LocalOverlayService(data, createLogger(root, "info"));
const sessions = new Map<string, Session>();
const bind = async (workspace: string) => {
  if (!sessions.has(workspace)) {
    sessions.set(workspace, { id: randomUUID(), workspace } as Session);
  }

  return sessions.get(workspace)!;
};

const signal = AbortSignal.timeout(120_000);
let lease: LocalOverlayLease | undefined;
try {
  const parentId = randomUUID();
  const parent = await service.create({ id: parentId, source }, bind);
  lease = await service.begin(
    parent.workspace,
    parent.id,
    randomUUID(),
    signal,
  );
  assert(lease);
  assert.equal(
    await readFile(path.join(parent.workspace, "dependency.txt"), "utf8"),
    "1",
  );
  await writeFile(path.join(parent.workspace, "module.mjs"), oldPrivate);
  await lease.finish("failed", true);
  lease = undefined;
  await writeFile(path.join(source, "module.mjs"), external);
  await writeFile(path.join(source, "dependency.txt"), "3");
  const review = await service.review(
    parent.workspace,
    parent.id,
    "module.mjs",
    signal,
  );
  assert.equal(review.preview.state, "conflict");
  const parentDb = path.join(service.root, parentId, "overlay.sqlite");
  const parentBefore = await readFile(parentDb);
  const input = {
    id: randomUUID(),
    workspace: parent.workspace,
    sessionId: parent.id,
    path: review.path,
    version: review.version,
  };
  const started = performance.now();
  const child = await service.continueResolution(input, bind);
  const creationMs = performance.now() - started;
  assert.equal((await service.continueResolution(input, bind)).id, child.id);
  assert.deepEqual(await readFile(parentDb), parentBefore);

  const taskId = randomUUID();
  lease = await service.begin(child.workspace, child.id, taskId, signal);
  assert(lease);
  assert.equal(
    await readFile(path.join(child.workspace, "module.mjs"), "utf8"),
    external,
  );
  assert.equal(
    await readFile(path.join(child.workspace, "dependency.txt"), "utf8"),
    "3",
  );
  const reference = path.join(child.workspace, resolutionDirectory(input.id));
  assert.equal(
    await readFile(path.join(reference, "ours"), "utf8"),
    oldPrivate,
  );
  await writeFile(path.join(child.workspace, "module.mjs"), resolved);
  await assert.rejects(
    service.select(child.workspace, child.id, taskId, {
      paths: [`${resolutionDirectory(input.id)}/ours`],
      validate: async () => {},
    }),
    /PATH_REJECTED/,
  );
  await service.select(child.workspace, child.id, taskId, {
    paths: ["module.mjs"],
    validate: async (files) => {
      const candidate = files.get("module.mjs");
      assert(candidate);
      const execution = await execute(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          candidate.toString() + "\nprocess.stdout.write(String(value));",
        ],
        { cwd: root, windowsHide: true, timeout: 10_000 },
      );
      assert.equal(execution.stdout, "30");
    },
  });
  const finished = await lease.finish("completed", true);
  lease = undefined;
  assert.equal(finished.publication?.state, "published");
  assert.equal(
    await readFile(path.join(source, "module.mjs"), "utf8"),
    resolved,
  );
  assert.equal(
    (await readdir(source)).some((name) =>
      name.startsWith(".codeatelier-recovery-"),
    ),
    false,
  );
  assert.deepEqual(await readFile(parentDb), parentBefore);
  const oldReview = await service.review(
    parent.workspace,
    parent.id,
    "module.mjs",
    signal,
  );
  assert.equal(
    Buffer.from(oldReview.ours.content!, "base64").toString(),
    oldPrivate,
  );
  assert.equal(Buffer.from(oldReview.base.content!, "base64").toString(), base);
  assert.equal(
    Buffer.from(oldReview.current.content!, "base64").toString(),
    resolved,
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
        creationMs,
        checks: [
          "old conflict retained",
          "parent database unchanged",
          "fixed request idempotent",
          "fresh source and dependency",
          "reference not applied or publishable",
          "candidate Node execution",
          "native publication and refresh",
          "old private edits preserved",
        ],
        limitations: [
          "Host fixture and trusted validation adapter, not Sandbox/model IPC v18",
          "Single selected file, no automatic semantic merge or complete project validation",
          "Old view intentionally preserved, no cleanup or in-place reset",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_RESOLUTION PASS report=${report}\n`);
} finally {
  try {
    await lease?.finish("cancelled", true);
  } finally {
    await service.close();
  }
}
