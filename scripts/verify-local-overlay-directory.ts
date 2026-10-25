/**
 * 手动验证 Local WinFsp 目录缓冲的实际 Win32 分页行为。
 * 1. 独占临时来源含 1500 个文件、跨 UTF-16 排序边界名称、空目录和隐藏 .git。
 * 2. 调用先构建的原生小缓冲探针，验证续页、第二句柄、restart 和 live/private 变化。
 * 3. 记录实际 lower 计数，干净重挂载后复核 private whiteout 与新来源可见，finally 排空挂载。
 * 探针仅改动本脚本夹具；不执行 Git/模型/Sandbox、安装或发布，不属于默认 check/Evaluation。
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
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";

assert.equal(process.platform, "win32");
const execute = promisify(execFile);
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-directory-"));
const source = path.join(root, "source");
const control = path.join(root, "control");
await mkdir(source);
await mkdir(path.join(source, "empty"));
await mkdir(path.join(source, ".git"));
for (let offset = 0; offset < 1500; offset += 100) {
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      writeFile(
        path.join(source, `f${String(offset + index).padStart(4, "0")}.txt`),
        "x",
      ),
    ),
  );
}

const unicode = ["\uE000.txt", "\u{10000}.txt", "\u{1F680}.txt", "中文.txt"];
for (const name of unicode) {
  await writeFile(path.join(source, name), "unicode");
}

const id = randomUUID();
const workspace = overlayWorkspace(overlayNamespace(root), id);
const log = createLogger(root, "info");
let manager = new OverlayManager(root, log);
try {
  await manager.start(
    id,
    source,
    control,
    workspace,
    true,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );
  const result = await execute(
    path.resolve(".local/winfsp-native-test/directory-probe.exe"),
    [workspace, source],
    { windowsHide: true, timeout: 120_000 },
  );
  const probe = JSON.parse(result.stdout.trim());
  assert.equal(probe.passed, true);
  assert.equal(probe.initialEntries, 1505);
  const metrics = await manager.metrics(id);
  assert(
    metrics.lowerEnumerations <= 12,
    "Continuation pages re-enumerated source",
  );
  await manager.close();
  manager = new OverlayManager(root, log);
  await manager.start(
    id,
    source,
    control,
    workspace,
    false,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );
  const names = await readdir(workspace);
  for (const name of [...unicode, "late.txt", "upper.txt"]) {
    assert(names.includes(name));
  }

  for (const name of [".git", "f0001.txt", "f1499.txt"]) {
    assert(!names.includes(name));
  }

  assert.equal(
    await readFile(path.join(workspace, "upper.txt"), "utf8"),
    "private",
  );
  assert.equal(await readFile(path.join(source, "f0001.txt"), "utf8"), "x");
  await manager.stop(id);
  const report = path.join(root, "report.json");
  await writeFile(
    report,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        release: os.release(),
        probe,
        metrics,
        remount: "passed",
        limitations: [
          "Real Win32/WinFsp, no Sandbox",
          "Per-enumeration metadata snapshot, not a source or content snapshot",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`LOCAL_DIRECTORY PASS report=${report}\n`);
} finally {
  await manager.close();
}
