/**
 * 手动验证 Local 专用 WinFsp 策略及创建成本，不接入真实用户仓库或模型。
 * 1. 在独占夹具中准备普通 Git 仓库、嵌套 gitfile/目录和内部链接；仅测试进程运行 Git。
 * 2. 真实挂载验证隐藏、直接访问、创建/rename 拒绝和普通源码配置可写；比较来源元数据。
 * 3. 干净卸载后验证跨模式恢复拒绝、同模式恢复成功，另验旧模式仍可创建私有 gitfile。
 * 4. 小目录与一万文件树各创建三次，计时并读取原生 lower 访问计数、私有文件逻辑字节。
 * 所有挂载均由本脚本排空关闭；不安装驱动、改 Sandbox 或发布文件，不属于默认 check/Evaluation。
 * 该实验只验证文件视图策略；显式外部 Git 路径依赖执行权限，不是 Git 程序封禁测试。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../src/logging/logger.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/local-overlays/winfsp-manager.js";
import { git, gitEnvironment } from "../src/worktrees/git.js";

assert.equal(process.platform, "win32");
const execute = promisify(execFile);
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-policy-"));
const source = path.join(root, "source");
await mkdir(source);
await git(source, ["init", "-b", "main"]);
await mkdir(path.join(source, "nested-dir", ".git"), { recursive: true });
await mkdir(path.join(source, "nested-file"));
await writeFile(
  path.join(source, "nested-dir", ".git", "config"),
  "private metadata",
);
await writeFile(
  path.join(source, "nested-file", ".git"),
  `gitdir: ${path.join(source, ".git")}\n`,
);
await writeFile(path.join(source, ".gitignore"), "output/\n");
await symlink(
  path.join(source, ".git"),
  path.join(source, "metadata-alias"),
  "junction",
);
const configBefore = await readFile(path.join(source, ".git", "config"));
const headBefore = await readFile(path.join(source, ".git", "HEAD"));
const log = createLogger(root, "info");

function view(label: string) {
  const id = randomUUID();

  return {
    id,
    control: path.join(root, label),
    workspace: overlayWorkspace(overlayNamespace(root), id),
  };
}

type View = ReturnType<typeof view>;
async function start(
  manager: OverlayManager,
  item: View,
  create: boolean,
  local = true,
  lower = source,
) {
  await manager.start(
    item.id,
    lower,
    item.control,
    item.workspace,
    create,
    AbortSignal.timeout(30_000),
    local ? { kind: "local" } : undefined,
  );
}

async function verifyPolicy(workspace: string) {
  for (const parent of ["", "nested-dir", "nested-file"]) {
    const directory = path.join(workspace, parent);
    assert(
      !(await readdir(directory)).some((name) => name.toLowerCase() === ".git"),
    );
    for (const spelling of [".git", ".GiT"]) {
      const forbidden = path.join(directory, spelling);
      await assert.rejects(lstat(forbidden), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(forbidden, "config")));
      await assert.rejects(writeFile(forbidden, "gitdir: external"));
      await assert.rejects(mkdir(forbidden));
      const temporary = path.join(directory, "rename-source");
      await writeFile(temporary, "retained after rejected rename");
      await assert.rejects(rename(temporary, forbidden));
      assert.equal(
        await readFile(temporary, "utf8"),
        "retained after rejected rename",
      );
      const folder = path.join(directory, "rename-directory");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "retained.txt"), "directory retained");
      await assert.rejects(rename(folder, forbidden));
      assert.equal(
        await readFile(path.join(folder, "retained.txt"), "utf8"),
        "directory retained",
      );
    }
  }

  await assert.rejects(
    readFile(path.join(workspace, "metadata-alias", "config")),
  );
  await writeFile(path.join(workspace, ".gitignore"), "private-output/\n");
  assert.equal(
    await readFile(path.join(source, ".gitignore"), "utf8"),
    "output/\n",
  );
  for (const args of [["status", "--porcelain"], ["init"]]) {
    await assert.rejects(
      execute("git", args, {
        cwd: workspace,
        env: { ...process.env, ...gitEnvironment() },
        timeout: 10_000,
        windowsHide: true,
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof Error && "stderr" in error && "code" in error,
        );
        assert.equal(
          typeof error.code,
          "number",
          "Git must actually start, not fail to spawn",
        );
        assert.match(
          String(error.stderr),
          args[0] === "status" ? /not a git repository/i : /\.git/i,
        );

        return true;
      },
    );
  }

  // A rejected operation must leave the mount usable, not poison its journal.
  await writeFile(path.join(workspace, "after-denial.txt"), "still usable");
  assert.equal(
    await readFile(path.join(workspace, "after-denial.txt"), "utf8"),
    "still usable",
  );
}

async function controlBytes(directory: string): Promise<number> {
  let total = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    total += item.isDirectory()
      ? await controlBytes(file)
      : (await stat(file)).size;
  }

  return total;
}

const current = view("local-control");
let manager = new OverlayManager(root, log);
try {
  await start(manager, current, true);
  const initial = await manager.metrics(current.id);
  assert.equal(initial.lowerEnumerations, 0);
  assert.equal(initial.lowerOpens, 0);
  assert.deepEqual(await readdir(path.join(current.control, "objects")), []);
  await verifyPolicy(current.workspace);
  await manager.close();

  const wrongMode = new OverlayManager(root, log);
  await assert.rejects(start(wrongMode, current, false, false));
  // Its child failed before readiness. close reports an unclean receipt; it
  // must not force-repair or rewrite the previously clean Local state.
  await assert.rejects(wrongMode.close());
  manager = new OverlayManager(root, log);
  await start(manager, current, false);
  await verifyPolicy(current.workspace);
  await manager.close();

  const legacy = view("legacy-control");
  manager = new OverlayManager(root, log);
  await start(manager, legacy, true, false);
  await writeFile(
    path.join(legacy.workspace, ".git"),
    "gitdir: private-only\n",
  );
  assert.equal(
    await readFile(path.join(legacy.workspace, ".git"), "utf8"),
    "gitdir: private-only\n",
  );
  await manager.close();
  const wrongLocal = new OverlayManager(root, log);
  await assert.rejects(start(wrongLocal, legacy, false));
  await assert.rejects(wrongLocal.close());

  const small = path.join(root, "empty-source");
  const large = path.join(root, "large-source");
  await mkdir(small);
  await mkdir(large);
  for (let directory = 0; directory < 100; directory++) {
    const folder = path.join(large, `d${directory}`);
    await mkdir(folder);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(
          path.join(folder, `f${index}.txt`),
          "synthetic source\n".repeat(8),
        ),
      ),
    );
  }

  const measurements = [];
  manager = new OverlayManager(root, log);
  for (let sample = 0; sample < 3; sample++) {
    for (const [files, lower] of [
      [0, small],
      [10_000, large],
    ] as const) {
      const item = view(`measure-${files}-${sample}`);
      const before = performance.now();
      await start(manager, item, true, true, lower);
      const createMs = performance.now() - before;
      const metrics = await manager.metrics(item.id);
      assert.equal(metrics.lowerEnumerations, 0);
      assert.equal(metrics.lowerOpens, 0);
      assert.deepEqual(await readdir(path.join(item.control, "objects")), []);
      const mountedControlLogicalBytes = await controlBytes(item.control);
      await manager.stop(item.id);
      measurements.push({
        files,
        sample,
        createMs,
        mountedControlLogicalBytes,
        stoppedControlLogicalBytes: await controlBytes(item.control),
        lowerOpens: metrics.lowerOpens,
        lowerEnumerations: metrics.lowerEnumerations,
      });
    }
  }

  assert.deepEqual(
    await readFile(path.join(source, ".git", "config")),
    configBefore,
  );
  assert.deepEqual(
    await readFile(path.join(source, ".git", "HEAD")),
    headBefore,
  );
  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    policy: "local; all .git components hidden and reserved",
    gitDirectoryAndFile: "passed",
    caseInsensitive: "passed",
    renameFailurePreservesSource: "passed",
    internalMetadataAlias: "denied",
    gitStatusAndInit: "rejected",
    cleanRemount: "passed",
    crossModeRestore: "rejected in both directions",
    legacyPrivateGitfile: "passed",
    measurements,
    limitations: [
      "Synthetic 10,000-file tree; not a giant real repository or cold-cache benchmark",
      "Control bytes are logical file lengths, not allocated NTFS clusters",
      "lowerOpens excludes the constant source-root identity/security handle",
      "Native normalized-path guard covers short-name resolution; this NTFS fixture has no 8.3 aliases",
      "No Sandbox, native changeset capture or publication validation in this script",
    ],
  };
  const reportFile = path.join(root, "report.json");
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`LOCAL_OVERLAY_POLICY PASS report=${reportFile}\n`);
} finally {
  await manager.close();
}
