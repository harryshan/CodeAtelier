/**
 * 手动验证本机 NTFS + 已安装 WinFsp 的真实挂载，不调用模型服务或创建分区。
 * 1. 在 .local 独占夹具创建 dirty/staged/ignored 来源，用产品 WorktreeService 建立两个视图。
 * 2. 检查实时读取、copy-up、删除、rename、内部链接、Git 独立 index/HEAD 和共享 objects。
 * 3. 调用原生 Windows ACL/锁/映射验证，再关闭并重挂载检查稳定身份与持久内容。
 * 4. --sandbox 额外使用已安装专用账户 Runtime 和固定内存模型；fallback/未知清理均失败。
 * 5. 单独强制终止无任务的 helper，验证该私有层不能自动恢复；失败现场保留用于诊断。
 * 不属于 pnpm test/check；只改自己的夹具，服务和 Sandbox 安装保持不变。
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  stat,
  lstat,
  rename,
  unlink,
  symlink,
  open,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { WorktreeService } from "../src/worktrees/service.js";
import { overlayHelperPath } from "../src/worktrees/overlay.js";
import { git as runGit } from "../src/worktrees/git.js";
import type { Session } from "../src/shared/types.js";
import { verifyOverlaySandbox } from "./verify-winfsp-sandbox.js";

const execute = promisify(execFile);
const log = pino(
  { level: "warn" },
  {
    write(line: string) {
      const event = JSON.parse(line) as {
        event?: string;
        nativeStatus?: number;
        nativeLine?: number;
      };
      process.stderr.write(
        `OVERLAY_DIAGNOSTIC event=${event.event ?? "unknown"} status=${event.nativeStatus ?? 0} line=${event.nativeLine ?? 0}\n`,
      );
    },
  },
);

async function git(cwd: string, args: string[]) {
  return runGit(cwd, [
    "-c",
    `safe.directory=${cwd.replaceAll("\\", "/")}`,
    ...args,
  ]);
}

async function bind(workspace: string): Promise<Session> {
  return {
    id: randomUUID(),
    workspace,
    title: "overlay fixture",
    titleState: "pending",
    createdAt: "now",
    updatedAt: "now",
  };
}

async function verifyCrash(root: string, source: string) {
  const control = path.join(root, "crash-control");
  const prefix = `\\CodeAtelier\\${randomUUID()}`;
  const child = spawn(
    overlayHelperPath(),
    ["create", source, control, prefix],
    { windowsHide: true },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Crash fixture mount timed out")),
        10_000,
      );
      child.once("error", reject);
      child.stdout.once("data", (bytes: Buffer) => {
        clearTimeout(timer);
        if (String(bytes).includes('"state":"ready"')) {
          resolve();
        } else {
          reject(new Error("Crash fixture was not ready"));
        }
      });
    });
    await writeFile(`\\${prefix}\\saved.txt`, "private data retained\n");
  } finally {
    child.kill();
    await closed;
  }

  await assert.rejects(
    execute(overlayHelperPath(), ["restore", source, control, prefix], {
      windowsHide: true,
      timeout: 10_000,
    }),
    (error: unknown) => {
      assert.match((error as { stdout: string }).stdout, /"error":"native"/);

      return true;
    },
  );
  assert((await readdir(path.join(control, "objects"))).length > 0);
}

async function main() {
  assert.equal(process.platform, "win32", "Requires native Windows and WinFsp");
  await mkdir(path.resolve(".local"), { recursive: true });
  const root = await mkdtemp(path.resolve(".local/winfsp-verification-"));
  const source = path.join(root, "source");
  const data = path.join(root, "data");
  await mkdir(source);
  await mkdir(data);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Overlay fixture"]);
  await git(source, ["config", "user.email", "overlay@example.invalid"]);
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await writeFile(path.join(source, ".gitignore"), "ignored\nnode_modules/\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  await writeFile(path.join(source, "tracked.txt"), "staged\n");
  await git(source, ["add", "tracked.txt"]);
  await writeFile(path.join(source, "tracked.txt"), "dirty\n");
  await writeFile(path.join(source, "ignored"), "live-1\n");
  await writeFile(path.join(source, "acl.txt"), "AAAAAAAA\n");
  await mkdir(path.join(source, "folder"));
  await writeFile(path.join(source, "folder", "nested.txt"), "lower\n");
  await mkdir(path.join(source, "node_modules"));
  await symlink(
    path.join(source, "folder"),
    path.join(source, "node_modules", "package"),
    "junction",
  );
  const head = await git(source, ["rev-parse", "HEAD"]);
  const index = await readFile(path.join(source, ".git", "index"));
  const status = await git(source, ["status", "--porcelain"]);
  const input = { id: randomUUID(), workspace: source };
  let service = new WorktreeService(data, log);
  process.stdout.write(`OVERLAY_VERIFY fixture=${root}\n`);
  try {
    const first = await service.createRiftri(input, bind);
    const second = await service.createRiftri(
      { ...input, id: randomUUID() },
      bind,
    );
    const workspace = first.workspace;
    const identity = await stat(workspace, { bigint: true });
    assert.equal(first.worktree?.backend, "riftri-winfsp");
    assert.equal(await service.projectWorkspace(workspace), source);
    assert.equal((await service.gitWriteRoots(workspace)).length, 1);
    assert.equal(await git(workspace, ["status", "--porcelain"]), status);
    assert.equal(await git(workspace, ["show", ":tracked.txt"]), "staged");
    assert.equal(
      await readFile(path.join(workspace, "ignored"), "utf8"),
      "live-1\n",
    );
    await writeFile(path.join(source, "ignored"), "live-2\n");
    assert.equal(
      await readFile(path.join(workspace, "ignored"), "utf8"),
      "live-2\n",
    );
    await writeFile(path.join(workspace, "tracked.txt"), "task\n");
    assert.equal(
      await readFile(path.join(second.workspace, "tracked.txt"), "utf8"),
      "dirty\n",
    );
    await unlink(path.join(workspace, "ignored"));
    assert.equal(
      await readFile(path.join(source, "ignored"), "utf8"),
      "live-2\n",
    );
    await assert.rejects(readFile(path.join(workspace, "ignored")), {
      code: "ENOENT",
    });
    const link = path.join(workspace, "node_modules", "package");
    assert((await lstat(link)).isSymbolicLink());
    await writeFile(path.join(link, "nested.txt"), "via virtual link\n");
    assert.equal(
      await readFile(path.join(workspace, "folder", "nested.txt"), "utf8"),
      "via virtual link\n",
    );
    assert.equal(
      await readFile(path.join(source, "folder", "nested.txt"), "utf8"),
      "lower\n",
    );
    await unlink(link);
    assert(
      (
        await lstat(path.join(source, "node_modules", "package"))
      ).isSymbolicLink(),
    );

    await writeFile(path.join(workspace, "atomic.tmp"), "replacement\n");
    const old = await open(path.join(workspace, "tracked.txt"), "r");
    try {
      // Node uses MoveFileEx on Windows: NTFS also rejects replacement of an open target.
      await assert.rejects(
        rename(
          path.join(workspace, "atomic.tmp"),
          path.join(workspace, "tracked.txt"),
        ),
        { code: "EPERM" },
      );
      assert.equal(await old.readFile("utf8"), "task\n");
    } finally {
      await old.close();
    }

    await rename(
      path.join(workspace, "atomic.tmp"),
      path.join(workspace, "tracked.txt"),
    );
    await rename(
      path.join(workspace, "tracked.txt"),
      path.join(workspace, "TRACKED.txt"),
    );
    assert((await readdir(workspace)).includes("TRACKED.txt"));
    await rename(
      path.join(workspace, "TRACKED.txt"),
      path.join(workspace, "tracked.txt"),
    );
    await writeFile(
      path.join(source, "rename-lower.txt"),
      "retained after rename\n",
    );
    await rename(
      path.join(workspace, "rename-lower.txt"),
      path.join(workspace, "rename-private.txt"),
    );
    await unlink(path.join(source, "rename-lower.txt"));
    assert.equal(
      await readFile(path.join(workspace, "rename-private.txt"), "utf8"),
      "retained after rename\n",
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeFile(path.join(workspace, `parallel-${i}`), String(i)),
      ),
    );
    for (let i = 0; i < 8; i++) {
      assert.equal(
        await readFile(path.join(workspace, `parallel-${i}`), "utf8"),
        String(i),
      );
    }

    const acl = await execute(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        path.resolve("scripts/verify-winfsp-acl.ps1"),
        "-Workspace",
        workspace,
        "-Source",
        source,
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    assert.match(acl.stdout, /OVERLAY_ACL_LOCK_MAPPING PASS/);
    await rename(
      path.join(workspace, "folder"),
      path.join(workspace, "renamed"),
    );
    assert.equal(
      await readFile(path.join(workspace, "renamed", "nested.txt"), "utf8"),
      "via virtual link\n",
    );
    await unlink(path.join(source, "folder", "nested.txt"));
    await rmdir(path.join(source, "folder"));
    assert.equal(
      await readFile(path.join(workspace, "renamed", "nested.txt"), "utf8"),
      "via virtual link\n",
    );
    await git(workspace, ["add", "tracked.txt"]);
    await git(workspace, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "task",
    ]);
    assert.equal(await git(source, ["rev-parse", "HEAD"]), head);
    assert.deepEqual(await readFile(path.join(source, ".git", "index")), index);
    assert.equal(
      await readFile(path.join(source, "tracked.txt"), "utf8"),
      "dirty\n",
    );
    await service.close();
    await assert.rejects(stat(workspace));
    service = new WorktreeService(data, log);
    await service.validate(workspace);
    const after = await stat(workspace, { bigint: true });
    assert.equal(after.dev, identity.dev);
    assert.equal(after.ino, identity.ino);
    assert.equal(after.birthtimeNs, identity.birthtimeNs);
    assert.equal(
      await readFile(path.join(workspace, "tracked.txt"), "utf8"),
      "replacement\n",
    );
    await assert.rejects(readFile(path.join(workspace, "ignored")), {
      code: "ENOENT",
    });
  } finally {
    await service.close();
  }

  if (process.argv.includes("--sandbox")) {
    await verifyOverlaySandbox(root);
  }

  const crashSource = path.join(root, "crash-source");
  await mkdir(crashSource);
  await verifyCrash(root, crashSource);
  process.stdout.write(`OVERLAY_VERIFY PASS fixture=${root}\n`);
}

await main();
