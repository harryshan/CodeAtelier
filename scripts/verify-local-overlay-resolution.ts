/**
 * 手动验证保留旧私有修改、建立新 Local 对话并重新编辑/发布的真实 WinFsp 流程。
 * 1. 旧视图读取依赖并产生两个私有修改，外部更新来源后整组检查旧 B/O/T；任一文件过期拒绝分配。
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
await writeFile(path.join(source, "message.txt"), "base message");
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
  await writeFile(
    path.join(parent.workspace, "message.txt"),
    "old private message",
  );
  await lease.finish("failed", true);
  lease = undefined;
  await writeFile(path.join(source, "module.mjs"), external);
  await writeFile(path.join(source, "dependency.txt"), "3");
  const paths = ["message.txt", "module.mjs"];
  const review = await service.reviewBatch(
    parent.workspace,
    parent.id,
    paths,
    signal,
  );
  assert.equal(
    review.files.find((file) => file.path === "module.mjs")?.preview.state,
    "conflict",
  );
  const parentDb = path.join(service.root, parentId, "overlay.sqlite");
  const parentBefore = await readFile(parentDb);
  const input = {
    id: randomUUID(),
    workspace: parent.workspace,
    sessionId: parent.id,
    paths,
    version: review.version,
  };
  await writeFile(path.join(source, "message.txt"), "external message");
  await assert.rejects(service.continueResolution(input, bind), /材料已经改变/);
  assert.equal(sessions.size, 1);
  await assert.rejects(readFile(path.join(service.root, `${input.id}.json`)), {
    code: "ENOENT",
  });
  input.version = (
    await service.reviewBatch(parent.workspace, parent.id, paths, signal)
  ).version;
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
  const manifest = JSON.parse(
    await readFile(path.join(reference, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, 2);
  assert.deepEqual(
    manifest.entries.map((entry: { path: string; directory: string }) => [
      entry.path,
      entry.directory,
    ]),
    [
      ["message.txt", "0000"],
      ["module.mjs", "0001"],
    ],
  );
  assert.equal(
    await readFile(path.join(reference, "0001", "ours"), "utf8"),
    oldPrivate,
  );
  assert.equal(
    await readFile(path.join(reference, "0000", "ours"), "utf8"),
    "old private message",
  );
  assert.equal(
    await readFile(path.join(child.workspace, "message.txt"), "utf8"),
    "external message",
  );
  await writeFile(path.join(child.workspace, "module.mjs"), resolved);
  await writeFile(
    path.join(child.workspace, "message.txt"),
    "resolved message",
  );
  await assert.rejects(
    service.select(child.workspace, child.id, taskId, {
      paths: [`${resolutionDirectory(input.id)}/0001/ours`],
      validate: async () => {},
    }),
    /PATH_REJECTED/,
  );
  await service.select(child.workspace, child.id, taskId, {
    paths,
    validate: async (files) => {
      const candidate = files.get("module.mjs");
      assert(candidate);
      assert.equal(files.get("message.txt")?.toString(), "resolved message");
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
    await readFile(path.join(source, "message.txt"), "utf8"),
    "resolved message",
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
          "stale member refuses entire group before allocation",
          "two selected files preserved in numbered v2 references",
          "fresh source and dependency",
          "reference not applied or publishable",
          "candidate Node execution",
          "native publication and refresh",
          "old private edits preserved",
        ],
        limitations: [
          "Host fixture and trusted validation adapter, not Sandbox/model IPC v18",
          "Two small selected files, no automatic semantic merge or complete project validation",
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
