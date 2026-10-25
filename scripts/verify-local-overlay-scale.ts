/**
 * 手动测量 Local overlay 在大文件树上的创建、访问与私有磁盘成本。
 * 1. 在独占 .local 目录生成有界合成来源，准备耗时不计入创建；不接触用户项目。
 * 2. 原生挂载核对零 lower 枚举/打开及零内容复制，生产 Service + AsyncStore 另测端到端创建。
 * 3. 记录首次/再次遍历、有限读取、双会话私有写入和大文件单字节修改的成本。
 * 4. 复用只读 NTFS AllocationSize 计量，报告元数据/基线/内容分配；所有自身挂载在 finally 关闭。
 * 不清 OS 缓存、不发布文件、不安装/Repair 或运行 Sandbox，不属于默认 check/Evaluation。
 * 遍历是显式的后续阶段；创建证据必须在任何视图遍历/内容访问之前取得。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../src/logging/logger.js";
import { LocalOverlayService } from "../src/local-overlays/service.js";
import { AsyncStore } from "../src/sessions/async-store.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";

assert.equal(
  process.platform,
  "win32",
  "Requires Windows and existing WinFsp.",
);
const args = process.argv.slice(2);
assert(
  args.every((arg) => /^--count=\d+$/.test(arg)),
  "Unknown benchmark option",
);
assert(args.length <= 1);
const count = Number(args[0]?.slice(8) ?? 100_000);
assert(Number.isInteger(count) && count >= 100 && count <= 1_000_000);
const execute = promisify(execFile);
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-scale-"));
const log = createLogger(root, "info");
const manager = new OverlayManager(root, log);
const product = path.join(root, "product");
await mkdir(product);
const store = await AsyncStore.open(path.join(product, "history.sqlite"));
const service = new LocalOverlayService(product, log);
const fileSize = 256;
const largeBytes = 64 * 1024 * 1024;
const results: Record<string, unknown> = {};

function progress(stage: string) {
  process.stdout.write(`LOCAL_OVERLAY_SCALE ${stage}\n`);
}

async function measured<T>(operation: () => Promise<T>) {
  const started = performance.now();
  const value = await operation();

  return { ms: performance.now() - started, value };
}

async function disk(directories: string[]) {
  const input = path.join(root, `disk-${randomUUID()}.json`);
  await writeFile(input, JSON.stringify(directories));
  const result = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts/measure-worktree-disk.ps1"),
      "-InputFile",
      input,
    ],
    { windowsHide: true, timeout: 600_000 },
  );

  return JSON.parse(result.stdout.trim()) as {
    files: number;
    logicalBytes: number;
    allocatedBytes: number;
  };
}

async function footprint(control: string) {
  return {
    total: await disk([control]),
    objects: await disk([path.join(control, "objects")]),
    baselines: await disk([path.join(control, "baselines")]),
  };
}

function view(label: string) {
  const id = randomUUID();

  return {
    id,
    control: path.join(root, label),
    workspace: overlayWorkspace(overlayNamespace(root), id),
  };
}

async function mount(item: ReturnType<typeof view>, source: string) {
  await manager.start(
    item.id,
    source,
    item.control,
    item.workspace,
    true,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );
}

async function walk(directory: string): Promise<number> {
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Synthetic source must not contain links");
    files += entry.isDirectory()
      ? await walk(path.join(directory, entry.name))
      : 1;
  }

  return files;
}

async function prepare(files: number) {
  const source = path.join(root, `source-${files}`);
  await mkdir(source);
  const started = performance.now();
  for (let offset = 0; offset < files; offset += 100) {
    const folder = path.join(source, `d${offset / 100}`);
    await mkdir(folder);
    await Promise.all(
      Array.from({ length: Math.min(100, files - offset) }, (_, index) =>
        writeFile(
          path.join(folder, `f${index}.txt`),
          Buffer.alloc(fileSize, 65 + (index % 26)),
        ),
      ),
    );
    if (offset % 10_000 === 0) {
      progress(`prepare files=${offset}/${files}`);
    }
  }

  return { source, files, prepareMs: performance.now() - started };
}

try {
  const sources = [];
  for (const files of [...new Set([0, Math.min(10_000, count), count])]) {
    sources.push(await prepare(files));
  }

  results.sources = sources;
  const creates = [];
  for (const source of sources) {
    for (let sample = 0; sample < 3; sample++) {
      const item = view(`create-${source.files}-${sample}`);
      const native = await measured(() => mount(item, source.source));
      const metrics = await manager.metrics(item.id);
      assert.equal(metrics.lowerEnumerations, 0);
      assert.equal(metrics.lowerOpens, 0);
      assert.deepEqual(await readdir(path.join(item.control, "objects")), []);
      assert.deepEqual(await readdir(path.join(item.control, "baselines")), []);
      const mountedDisk = await disk([item.control]);
      await manager.stop(item.id);
      const productCreate = await measured(() =>
        service.create(
          { id: randomUUID(), source: source.source },
          async (workspace) => store.createAsync(workspace),
        ),
      );
      const info = (await service.describe(productCreate.value)).localOverlay;
      assert.equal(info?.state, "ready");
      creates.push({
        files: source.files,
        sample,
        nativeMs: native.ms,
        productMs: productCreate.ms,
        metrics,
        mountedDisk,
        stoppedDisk: await disk([item.control]),
      });
      progress(`created files=${source.files} sample=${sample}`);
    }
  }

  results.creates = creates;

  const largest = sources.at(-1)!;
  const source = largest.source;
  const item = view("access-a");
  await mount(item, source);
  const sourceWalk = await measured(() => walk(source));
  progress("first virtual walk started");
  const firstWalk = await measured(() => walk(item.workspace));
  const firstMetrics = await manager.metrics(item.id);
  assert.equal(firstWalk.value, count);
  assert.equal(sourceWalk.value, count);
  assert.equal(typeof firstMetrics.lowerImportCommits, "number");
  assert(
    firstMetrics.lowerImportCommits! <= Math.ceil(count / 100) + 1,
    "Local enumeration must commit metadata per directory, not per file",
  );
  const firstDisk = await footprint(item.control);
  assert.equal(firstDisk.objects.files, 0);
  assert.equal(firstDisk.baselines.files, 0);
  progress(`first virtual walk finished ms=${firstWalk.ms.toFixed(0)}`);
  const secondWalk = await measured(() => walk(item.workspace));
  assert.equal(secondWalk.value, count);
  const read = await measured(async () => {
    for (let index = 0; index < 32; index++) {
      assert.deepEqual(
        await readFile(path.join(item.workspace, "d0", `f${index}.txt`)),
        Buffer.alloc(fileSize, 65 + (index % 26)),
      );
    }
  });
  const afterReads = await footprint(item.control);
  assert.equal(afterReads.objects.files, 0);
  assert.equal(afterReads.baselines.files, 0);
  results.access = {
    sourceWalk,
    firstWalk,
    firstMetrics,
    firstDisk,
    secondWalk,
    read32Ms: read.ms,
    afterReads,
    finalMetrics: await manager.metrics(item.id),
  };

  // A second view gets its own B/O. These are file-system measurements, not Runtime claims.
  const peer = view("access-b");
  await mount(peer, source);
  const changed = path.join("d0", "f0.txt");
  await Promise.all([
    writeFile(path.join(item.workspace, changed), "private A"),
    writeFile(path.join(peer.workspace, changed), "private B"),
  ]);
  assert.equal(
    await readFile(path.join(item.workspace, changed), "utf8"),
    "private A",
  );
  assert.equal(
    await readFile(path.join(peer.workspace, changed), "utf8"),
    "private B",
  );
  assert.deepEqual(
    await readFile(path.join(source, changed)),
    Buffer.alloc(fileSize, 65),
  );
  results.peerWrites = {
    a: await footprint(item.control),
    b: await footprint(peer.control),
  };

  // Actually write the source payload (no sparse-length trick); change one byte in A only.
  const payload = Buffer.alloc(largeBytes, 0x61);
  await writeFile(path.join(source, "large.bin"), payload);
  const beforeLarge = await footprint(item.control);
  const write = await measured(async () => {
    const handle = await open(path.join(item.workspace, "large.bin"), "r+");
    try {
      await handle.write(Buffer.from("b"), 0, 1, 0);
    } finally {
      await handle.close();
    }
  });
  assert.deepEqual(await readFile(path.join(source, "large.bin")), payload);
  const privateBytes = await readFile(path.join(item.workspace, "large.bin"));
  assert.equal(privateBytes[0], 0x62);
  assert.deepEqual(privateBytes.subarray(1), payload.subarray(1));
  results.largeWrite = {
    sourceBytes: largeBytes,
    changedBytes: 1,
    ms: write.ms,
    before: beforeLarge,
    after: await footprint(item.control),
  };
  await manager.stop(item.id);
  await manager.stop(peer.id);
  results.stoppedAccess = await footprint(item.control);
  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    count,
    fileSize,
    results,
    limitations: [
      "Synthetic local NTFS tree; no cold-cache, real build, Git or OS Sandbox claim",
      "Allocation excludes NTFS MFT/directory/journal overhead; source preparation and measurement are excluded from operation timings",
      "lowerOpens excludes the constant source-root identity/security handle",
      "Service timing includes real Store binding and clean unmount, but not HTTP or Runtime startup",
      "Read-only enumeration can persist namespace metadata; file-level copy-up copies complete content and baseline",
    ],
  };
  const output = path.join(root, "report.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  progress(`PASS report=${output}`);
} finally {
  const cleanup = await Promise.allSettled([manager.close(), service.close()]);
  cleanup.push(...(await Promise.allSettled([store.close()])));
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Benchmark cleanup failed; fixtures retained",
    );
  }
}
