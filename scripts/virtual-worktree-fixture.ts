/**
 * 人工虚拟 worktree PoC 的 Git/挂载夹具，不进入产品创建入口或默认测试。
 * 1. gitAt 使用固定 Git CLI、受控环境和真实 optional index refresh；输出只用于断言。
 * 2. fixture 流式 fast-import 指定数量的唯一/复用 blob 与基线提交，不展开来源工作文件。
 * 3. virtualWorktree 分别计量 no-checkout 登记、read-tree、挂载和绑定；不复制来源 index。
 * 4. 返回验证/关闭方法；失败现场及登记保留，挂载仅由本夹具拥有的 OverlayManager 清理。
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pino from "pino";
import { gitEnvironment, directoryIdentity } from "../src/worktrees/git.js";
import { attachOverlayGit } from "../src/worktrees/overlay-git.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";

const execute = promisify(execFile);
export const pocEnvironment = {
  ...process.env,
  ...gitEnvironment(),
  GIT_OPTIONAL_LOCKS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ATTR_NOSYSTEM: "1",
};

export async function gitAt(cwd: string, args: string[]) {
  const result = await execute(
    "git",
    ["-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, ...args],
    {
      cwd,
      env: pocEnvironment,
      windowsHide: true,
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  return result.stdout.trim();
}

export async function fixture(
  root: string,
  count: number,
  uniqueBlobs = Math.min(count, 1000),
) {
  const source = path.join(root, "source");
  await mkdir(source);
  await gitAt(source, ["init", "-b", "main"]);
  for (const [key, value] of Object.entries({
    "user.name": "Virtual worktree fixture",
    "user.email": "virtual@example.invalid",
    "core.autocrlf": "false",
    "core.filemode": "false",
    "core.fsmonitor": "false",
    "core.untrackedCache": "false",
    "commit.gpgsign": "false",
    "core.attributesFile": path.join(source, ".git", "empty-attributes"),
  })) {
    await gitAt(source, ["config", key, value]);
  }

  await writeFile(path.join(source, ".git", "empty-attributes"), "");
  // Record the unique count so repeated and unique-content scans are comparable.
  // Stream records to avoid allocating the entire large fixture in JS memory.
  const blobs = uniqueBlobs;
  function* records() {
    for (let index = 0; index < blobs; index++) {
      const content = `${index}:`.padEnd(4095, "x") + "\n";
      yield `blob\nmark :${index + 1}\ndata 4096\n${content}\n`;
    }

    yield `commit refs/heads/main\nmark :${blobs + 1}\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 4\nbase\n`;
    for (let index = 0; index < count; index++) {
      yield `M 100644 :${(index % blobs) + 1} d${Math.floor(index / 1000)
        .toString()
        .padStart(5, "0")}/f${index.toString().padStart(7, "0")}.txt\n`;
    }

    yield "\ndone\n";
  }

  const child = spawn("git", ["fast-import", "--quiet"], {
    cwd: source,
    env: pocEnvironment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (bytes: Buffer) => {
    errors = (errors + bytes.toString()).slice(-4096);
  });
  child.stdout.resume();
  const finished = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Fixture fast-import failed: ${errors}`)),
    );
  });
  await Promise.all([
    pipeline(Readable.from(records()), child.stdin),
    finished,
  ]);
  assert.deepEqual(await readdir(source), [".git"]);

  return {
    source,
    commit: await gitAt(source, ["rev-parse", "HEAD"]),
    count,
    blobs,
  };
}

export async function virtualWorktree(
  source: string,
  revision: string,
  root: string,
) {
  await mkdir(root);
  const id = randomUUID();
  const workspace = overlayWorkspace(overlayNamespace(root), id);
  const control = path.join(root, "control");
  const staging = path.join(root, "registration");
  const manager = new OverlayManager(root, pino({ enabled: false }));
  const times: Record<string, number> = {};
  const start = performance.now();
  async function measure<T>(stage: string, action: () => Promise<T>) {
    const begin = performance.now();
    try {
      return await action();
    } finally {
      times[stage] = performance.now() - begin;
    }
  }

  try {
    const commit = await gitAt(source, [
      "rev-parse",
      "--verify",
      `${revision}^{commit}`,
    ]);
    const tree = await gitAt(source, ["rev-parse", `${commit}^{tree}`]);
    assert.match(tree, /^[a-f0-9]{40}$/);
    const directory = await gitAt(source, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const executable = (
      await execute("where.exe", ["git.exe"], { windowsHide: true })
    ).stdout.split(/\r?\n/)[0]!;
    await measure("registrationMs", () =>
      gitAt(source, [
        "worktree",
        "add",
        "--lock",
        "--reason",
        "CodeAtelier virtual PoC",
        "--detach",
        "--no-checkout",
        "--",
        staging,
        commit,
      ]),
    );
    assert.deepEqual(await readdir(staging), [".git"]);
    const adminDirectory = await gitAt(staging, [
      "rev-parse",
      "--absolute-git-dir",
    ]);
    await measure("indexMs", () => gitAt(staging, ["read-tree", commit]));
    assert.deepEqual(await readdir(staging), [".git"]);
    const base = { executable, directory, tree };
    await measure("mountMs", () =>
      manager.start(
        id,
        source,
        control,
        workspace,
        true,
        AbortSignal.timeout(30_000),
        base,
      ),
    );
    const mountMetrics = await manager.metrics(id);
    const registrationGitfile = await readFile(
      path.join(staging, ".git"),
      "utf8",
    );
    await measure("attachMs", () =>
      attachOverlayGit(
        source,
        workspace,
        {
          adminDirectory,
          commonDirectory: directory,
          head: commit,
          gitfile: registrationGitfile,
        },
        AbortSignal.timeout(30_000),
      ),
    );
    times.readyMs = performance.now() - start;
    const identity = await directoryIdentity(workspace);
    const gitfile = await readFile(path.join(workspace, ".git"), "utf8");

    return {
      id,
      source,
      root,
      workspace,
      control,
      adminDirectory,
      commonDirectory: directory,
      commit,
      base,
      manager,
      times,
      mountMetrics,
      identity,
      async validate(candidate = workspace) {
        assert.equal(candidate, workspace);
        assert.equal(await directoryIdentity(workspace), identity);
        assert.equal(
          await readFile(path.join(workspace, ".git"), "utf8"),
          gitfile,
        );
        assert.equal(
          path.resolve(
            (
              await readFile(path.join(adminDirectory, "gitdir"), "utf8")
            ).trim(),
          ),
          path.join(workspace, ".git"),
        );
      },
      close: () => manager.close(),
    };
  } catch (error) {
    await manager.close();
    throw error;
  }
}

export type VirtualWorktree = Awaited<ReturnType<typeof virtualWorktree>>;
