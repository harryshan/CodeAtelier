/**
 * 手动运行的 Windows Git 虚拟 worktree PoC；不属于默认测试或 Evaluation。
 * 1. verify 用小型对象夹具检查提交基线、双视图隔离、Git 变更/重置、卸载恢复和可选真实 Sandbox。
 * 2. benchmark 从未 checkout 的大树创建虚拟/普通 worktree，分别计量创建与首次/重复 status。
 * 3. disk 只枚举自己的物理 upper/admin/普通 checkout，计入 SQLite/WAL/index 的真实分配长度。
 * 4. 将命令、环境、计数和耗时保存到独占 .local 目录；正常退出关闭自己挂载，失败保留现场。
 * 不部署、不更改默认模式、不修复/安装 Sandbox；首次命令不宣称 OS 冷缓存。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { OverlayManager } from "../src/worktrees/overlay.js";
import { directoryIdentity } from "../src/worktrees/git.js";
import {
  fixture,
  gitAt,
  virtualWorktree,
  type VirtualWorktree,
} from "./virtual-worktree-fixture.js";
import { verifyVirtualSandbox } from "./verify-virtual-worktree-sandbox.js";

const execute = promisify(execFile);
const repository = process.cwd();
const file = "d00000/f0000000.txt";
const args = process.argv.slice(2);
assert.equal(
  process.platform,
  "win32",
  "This PoC requires Windows and the installed WinFsp runtime.",
);
const count = Number(
  args.find((arg) => arg.startsWith("--count="))?.slice(8) ?? 100_000,
);
assert(Number.isInteger(count) && count >= 8 && count <= 1_000_000);
await mkdir(path.join(repository, ".local"), { recursive: true });
const root = await mkdtemp(
  path.join(repository, ".local", "virtual-worktree-poc-"),
);
function progress(stage: string) {
  process.stdout.write(`VIRTUAL_POC ${stage}\n`);
}

async function verify() {
  const location = path.join(root, "verification");
  await mkdir(location);
  const base = await fixture(location, 8);
  await gitAt(base.source, ["read-tree", base.commit]);
  await mkdir(path.join(base.source, "d00000"));
  await writeFile(path.join(base.source, file), "staged source\n");
  await gitAt(base.source, ["add", file]);
  await writeFile(path.join(base.source, file), "dirty source\n");
  await writeFile(path.join(base.source, "source-only.txt"), "untracked\n");
  const index = await readFile(path.join(base.source, ".git", "index"));
  const first = await virtualWorktree(
    base.source,
    base.commit,
    path.join(location, "first"),
  );
  let second: VirtualWorktree | undefined;
  try {
    second = await virtualWorktree(
      base.source,
      base.commit,
      path.join(location, "second"),
    );
    for (const view of [first, second]) {
      assert.equal(view.mountMetrics.treeReads, 0);
      assert.equal(view.mountMetrics.blobReads, 0);
      const ready = await view.manager.metrics(view.id);
      assert.equal(ready.blobReads, 0);
      assert.equal(ready.lowerOpens, 0);
      assert.equal(ready.lowerEnumerations, 0);
      assert.equal(
        await gitAt(view.workspace, ["status", "--porcelain=v1"]),
        "",
      );
      assert.match(
        await readFile(path.join(view.workspace, file), "utf8"),
        /^0:/,
      );
      await assert.rejects(
        readFile(path.join(view.workspace, "source-only.txt")),
        { code: "ENOENT" },
      );
    }

    await writeFile(path.join(first.workspace, file), "private change\n");
    assert.match(
      await gitAt(first.workspace, ["diff", "--", file]),
      /private change/,
    );
    assert.match(
      await readFile(path.join(second.workspace, file), "utf8"),
      /^0:/,
    );
    await gitAt(first.workspace, ["add", file]);
    await writeFile(path.join(first.workspace, ".gitignore"), "ignored-new\n");
    await writeFile(path.join(first.workspace, ".hidden"), "hidden base\n");
    await gitAt(first.workspace, ["add", ".gitignore", ".hidden"]);
    assert.match(
      await gitAt(first.workspace, ["diff", "--cached", "--", file]),
      /private change/,
    );
    await gitAt(first.workspace, [
      "switch",
      "-c",
      `codex/virtual-poc-${randomUUID()}`,
    ]);
    await gitAt(first.workspace, ["commit", "-m", "private commit"]);
    const privateCommit = await gitAt(first.workspace, ["rev-parse", "HEAD"]);
    assert.notEqual(privateCommit, base.commit);
    const selected = await virtualWorktree(
      base.source,
      privateCommit,
      path.join(location, "selected-commit"),
    );
    try {
      assert.equal(
        await readFile(path.join(selected.workspace, file), "utf8"),
        "private change\n",
      );
      assert.equal(
        await readFile(path.join(selected.workspace, ".hidden"), "utf8"),
        "hidden base\n",
      );
      assert.equal(
        await gitAt(selected.workspace, ["status", "--porcelain=v1"]),
        "",
      );
    } finally {
      await selected.close();
    }

    await gitAt(first.workspace, ["reset", "--hard", base.commit]);
    assert.equal(
      await gitAt(first.workspace, ["status", "--porcelain=v1"]),
      "",
    );
    await rename(
      path.join(first.workspace, "d00000"),
      path.join(first.workspace, "moved"),
    );
    assert.match(
      await readFile(path.join(first.workspace, "moved/f0000000.txt"), "utf8"),
      /^0:/,
    );
    await rename(
      path.join(first.workspace, "moved"),
      path.join(first.workspace, "d00000"),
    );
    await unlink(path.join(first.workspace, "d00000/f0000001.txt"));
    assert.match(
      await gitAt(first.workspace, ["status", "--porcelain=v1"]),
      /^D d00000\/f0000001.txt$/,
    );
    await gitAt(first.workspace, ["restore", "--", "d00000/f0000001.txt"]);
    assert.equal(
      await gitAt(first.workspace, ["status", "--porcelain=v1"]),
      "",
    );
    if (args.includes("--sandbox")) {
      progress("sandbox_started");
      await verifyVirtualSandbox(first);
      progress("sandbox_passed");
    }

    assert.equal(await gitAt(base.source, ["rev-parse", "HEAD"]), base.commit);
    assert.deepEqual(
      await readFile(path.join(base.source, ".git", "index")),
      index,
    );
    assert.equal(
      await readFile(path.join(base.source, file), "utf8"),
      "dirty source\n",
    );
    await assert.rejects(readFile(path.join(base.source, "runtime.txt")), {
      code: "ENOENT",
    });
    await writeFile(
      path.join(first.workspace, "survives.txt"),
      "persistent upper\n",
    );
  } finally {
    await second?.close();
    await first.close();
  }

  const restored = new OverlayManager(first.root, pino({ enabled: false }));
  try {
    await restored.start(
      first.id,
      first.source,
      first.control,
      first.workspace,
      false,
      AbortSignal.timeout(30_000),
      first.base,
    );
    assert.equal(await directoryIdentity(first.workspace), first.identity);
    assert.equal(
      await readFile(path.join(first.workspace, "survives.txt"), "utf8"),
      "persistent upper\n",
    );
    assert.match(
      await readFile(path.join(first.workspace, file), "utf8"),
      /^0:/,
    );
    assert.equal((await restored.metrics(first.id)).lowerOpens, 0);
  } finally {
    await restored.close();
  }

  return {
    git: "passed",
    isolation: "passed",
    restore: "passed",
    sandbox: args.includes("--sandbox") ? "passed" : "not requested",
  };
}

async function verifyUnsupportedTree() {
  const location = path.join(root, "unsupported");
  await mkdir(location);
  const base = await fixture(location, 8);
  await gitAt(base.source, ["read-tree", base.commit]);
  // Preserve absent tracked files in the index: only add the incompatible entry.
  await writeFile(
    path.join(base.source, ".gitattributes"),
    "* text eol=crlf\n",
  );
  await gitAt(base.source, ["add", ".gitattributes"]);
  await gitAt(base.source, ["commit", "-m", "unsupported conversion"]);
  const view = await virtualWorktree(
    base.source,
    "HEAD",
    path.join(location, "view"),
  );
  try {
    await assert.rejects(readdir(view.workspace));
    await assert.rejects(gitAt(view.workspace, ["status", "--porcelain=v1"]));
    assert.equal((await view.manager.metrics(view.id)).lowerOpens, 0);
  } finally {
    await view.close();
  }
}

async function disk(roots: string[]) {
  const input = path.join(root, `disk-input-${randomUUID()}.json`);
  await writeFile(input, JSON.stringify(roots));
  const result = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repository, "scripts/measure-worktree-disk.ps1"),
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

async function status(workspace: string) {
  const start = performance.now();
  const output = await gitAt(workspace, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  assert.equal(
    output,
    "",
    "Status must actually be clean, without index skip flags.",
  );

  return performance.now() - start;
}

async function benchmark() {
  const location = path.join(root, `benchmark-${count}`);
  await mkdir(location);
  progress(`fixture_started files=${count}`);
  const base = await fixture(location, count);
  progress("virtual_creation_started");
  const view = await virtualWorktree(
    base.source,
    base.commit,
    path.join(location, "virtual"),
  );
  let virtual;
  try {
    const ready = {
      metrics: await view.manager.metrics(view.id),
      disk: await disk([view.control, view.adminDirectory]),
    };
    assert.equal(ready.metrics.treeReads, 0);
    assert.equal(ready.metrics.blobReads, 0);
    progress(
      `virtual_ready ms=${view.times.readyMs.toFixed(1)} allocated=${ready.disk.allocatedBytes}`,
    );
    const firstStatusMs = await status(view.workspace);
    const first = {
      metrics: await view.manager.metrics(view.id),
      disk: await disk([view.control, view.adminDirectory]),
    };
    progress(
      `virtual_first_status ms=${firstStatusMs.toFixed(1)} blobs=${first.metrics.blobReads}`,
    );
    const secondStatusMs = await status(view.workspace);
    const second = {
      metrics: await view.manager.metrics(view.id),
      disk: await disk([view.control, view.adminDirectory]),
    };
    assert.equal(second.metrics.lowerOpens, 0);
    assert.equal(second.metrics.lowerEnumerations, 0);
    assert.equal(
      (await readdir(path.join(view.control, "objects"))).length,
      1,
      "Reads/status must not materialize tracked files; only private .git exists.",
    );
    virtual = {
      creation: view.times,
      mountMetrics: view.mountMetrics,
      ready,
      firstStatusMs,
      first,
      secondStatusMs,
      second,
    };
  } finally {
    await view.close();
  }

  assert.deepEqual(await readdir(base.source), [".git"]);
  progress("ordinary_creation_started");
  const ordinaryWorkspace = path.join(location, "ordinary");
  const start = performance.now();
  await gitAt(base.source, [
    "worktree",
    "add",
    "--detach",
    "--",
    ordinaryWorkspace,
    base.commit,
  ]);
  const readyMs = performance.now() - start;
  const admin = await gitAt(ordinaryWorkspace, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  const ready = await disk([ordinaryWorkspace, admin]);
  progress(
    `ordinary_ready ms=${readyMs.toFixed(1)} allocated=${ready.allocatedBytes}`,
  );
  const firstStatusMs = await status(ordinaryWorkspace);
  const secondStatusMs = await status(ordinaryWorkspace);
  const after = await disk([ordinaryWorkspace, admin]);

  return {
    files: count,
    fileBytes: 4096,
    uniqueBlobs: base.blobs,
    sourceWorkingFiles: 0,
    virtual,
    ordinary: { readyMs, ready, firstStatusMs, secondStatusMs, after },
  };
}

progress(`started root=${root}`);
const verification = await verify();
await verifyUnsupportedTree();
progress("verification_passed");
const measurements = args.includes("--verify-only")
  ? undefined
  : await benchmark();
const report = {
  timestamp: new Date().toISOString(),
  platform: os.platform(),
  release: os.release(),
  cpu: os.cpus()[0]?.model,
  node: process.version,
  git: await gitAt(repository, ["--version"]),
  verification,
  measurements,
  caveats: [
    "First command, not cold OS cache",
    "Virtual measured before ordinary",
    "Allocation excludes NTFS MFT/directory/journal overhead and shared Git object database",
    "Synthetic repeated 4 KiB blobs; no build/submodule/filter workload",
  ],
};
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
progress(`PASS report=${path.join(root, "report.json")}`);
