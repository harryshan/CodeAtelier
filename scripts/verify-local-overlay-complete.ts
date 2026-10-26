/**
 * 手动验证产品 Service 的完成态来源解锁，使用真实 WinFsp/Publisher 和独占 NTFS 夹具。
 * 1. 真实私有编辑、来源发布和视图确认完成后，原生租约正常关闭；仅注入关闭回执丢失以保留来源锁。
 * 2. 服务只能在读取 complete 日志并取得原生检查租约后解锁；不补写来源，失败私有现场字节保持不变。
 * 3. 重试幂等，新 Local 视图随后可正常发布，旧视图继续拒绝执行；finally 排空本脚本挂载。
 * 不修改用户项目/安装态，不运行模型、Sandbox 或 Evaluation；并非宿主强杀/断电恢复测试。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import {
  LocalOverlayService,
  type LocalOverlayLease,
} from "../src/local-overlays/service.js";
import { PublicationLease } from "../src/local-overlays/publication/publication-lease.js";
import type { Session } from "../src/shared/types.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-complete-"));
const source = path.join(root, "source");
await mkdir(source);
await writeFile(path.join(source, "code.txt"), "original\n");
const service = new LocalOverlayService(
  path.join(root, "data"),
  createLogger(root, "info"),
);
const bind = async (workspace: string) =>
  ({ id: randomUUID(), workspace }) as Session;
const signal = AbortSignal.timeout(120_000);
const startLease = PublicationLease.start;
let lease: LocalOverlayLease | undefined;

try {
  const id = randomUUID();
  const parent = await service.create({ id, source }, bind);
  const taskId = randomUUID();
  lease = await service.begin(parent.workspace, parent.id, taskId, signal);
  assert(lease);
  await writeFile(path.join(parent.workspace, "code.txt"), "published\n");
  await service.select(parent.workspace, parent.id, taskId, {
    paths: ["code.txt"],
    validate: async (files) => {
      assert.equal(files.get("code.txt")?.toString(), "published\n");
    },
  });
  PublicationLease.start = async (...args) => {
    const native = await startLease(...args);
    const close = native.close.bind(native);
    native.close = async () => {
      await close();
      throw new Error("injected lost close receipt");
    };

    return native;
  };

  try {
    await assert.rejects(
      lease.finish("completed", true),
      /injected lost close receipt/,
    );
  } finally {
    PublicationLease.start = startLease;
  }

  lease = undefined;
  assert.equal(
    await readFile(path.join(source, "code.txt"), "utf8"),
    "published\n",
  );
  const preserved = [
    path.join(service.root, `${id}.json`),
    path.join(service.root, `${id}.lock`),
    path.join(service.root, id, "overlay.sqlite"),
  ];
  const before = await Promise.all(preserved.map((file) => readFile(file)));
  assert.deepEqual(
    await service.publicationRecovery(
      parent.workspace,
      parent.id,
      undefined,
      signal,
    ),
    {
      kind: "complete",
      refresh: "confirmed",
    },
  );
  await writeFile(path.join(source, "code.txt"), "external after completion\n");
  const release = () =>
    service.publicationRecovery(
      parent.workspace,
      parent.id,
      { action: "release-complete" },
      signal,
    );
  assert.deepEqual(await release(), { kind: "complete-lock", released: true });
  assert.deepEqual(await release(), { kind: "complete-lock", released: false });
  assert.deepEqual(
    await Promise.all(preserved.map((file) => readFile(file))),
    before,
  );
  await assert.rejects(
    service.begin(parent.workspace, parent.id, randomUUID(), signal),
  );

  const child = await service.create({ id: randomUUID(), source }, bind);
  const nextTask = randomUUID();
  lease = await service.begin(child.workspace, child.id, nextTask, signal);
  assert(lease);
  await writeFile(path.join(child.workspace, "next.txt"), "next publication\n");
  await service.select(child.workspace, child.id, nextTask, {
    paths: ["next.txt"],
    validate: async (files) => {
      assert.equal(files.get("next.txt")?.toString(), "next publication\n");
    },
  });
  assert.equal(
    (await lease.finish("completed", true)).publication?.state,
    "published",
  );
  lease = undefined;
  assert.equal(
    await readFile(path.join(source, "next.txt"), "utf8"),
    "next publication\n",
  );
  assert.equal(
    await readFile(path.join(source, "code.txt"), "utf8"),
    "external after completion\n",
  );
  await service.close();
  const report = path.join(root, "report.json");
  await writeFile(
    report,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        passed: true,
        checks: [
          "real publication and refresh complete before lost lease close receipt",
          "native completed execution proof permits source lock release",
          "idempotent release preserves later external edits",
          "private manifest, lock and database unchanged",
          "old private view blocked; new view publishes successfully",
          "service drained",
        ],
        limitations: [
          "host fixture and trusted validator, not model or Sandbox",
          "no forced process termination or dirty-volume recovery",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_COMPLETE PASS report=${report}\n`);
} finally {
  PublicationLease.start = startLease;
  try {
    await lease?.finish("cancelled", true).catch(() => {});
  } finally {
    await service.close();
  }
}
