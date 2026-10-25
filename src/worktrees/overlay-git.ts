/**
 * 为实时 overlay 建立标准 linked worktree 的 Git 管理部分，供 Windows 工作区创建器调用。
 * 1. registerOverlayGit 核对来源 Git 布局/缓存模式，以 index.lock 阻止捕获期间修改暂存区。
 * 2. 只在空 staging 目录登记 no-checkout worktree，复制 index/sharedindex 并清除任务侧缓存。
 * 3. attachOverlayGit 将 gitfile 写入挂载视图，再用官方 repair 更新 backlink；不复制 objects 或工作文件。
 * 创建失败保留登记、锁及 staging，不删除或重放；公共 objects/refs 按标准 worktree 共享。
 */
import {
  copyFile,
  lstat,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

export interface OverlayGit {
  adminDirectory: string;
  commonDirectory: string;
  head: string;
  gitfile: string;
}

async function regularFile(file: string) {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new Error("Overlay Git metadata 不能是链接或特殊文件。");
  }

  return info;
}

async function headAt(source: string, signal: AbortSignal) {
  const head = await git(
    source,
    ["rev-parse", "--verify", "HEAD"],
    signal,
  ).catch(() => undefined);
  signal.throwIfAborted();
  if (head) {
    return head;
  }

  const ref = await git(source, ["symbolic-ref", "HEAD"], signal);
  const existing = await git(
    source,
    ["for-each-ref", "--format=%(refname)", ref],
    signal,
  );
  if (existing) {
    throw new Error("无法读取来源 HEAD。");
  }

  return "";
}

export async function registerOverlayGit(
  source: string,
  staging: string,
  id: string,
  signal: AbortSignal,
): Promise<OverlayGit> {
  const admin = await git(source, ["rev-parse", "--absolute-git-dir"], signal);
  const commonDirectory = await git(
    source,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  const config = await git(source, ["config", "--null", "--list"], signal);
  if (await regularFile(path.join(source, ".gitmodules"))) {
    throw new Error(
      "Overlay 暂不支持 submodule 工作区；请显式选择 Git worktree。",
    );
  }

  for (const entry of config.split("\0")) {
    const [key, value] = entry.split("\n");
    if (
      key === "core.worktree" ||
      ((key === "core.sparsecheckout" || key === "core.fsmonitor") &&
        value !== "false" &&
        value !== "0")
    ) {
      throw new Error(
        "Overlay 暂不支持 core.worktree、sparse-checkout 或启用 fsmonitor 的来源；请显式选择 Git worktree。",
      );
    }
  }

  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
  ]) {
    if (await lstat(path.join(admin, marker)).catch(() => undefined)) {
      throw new Error(
        "来源正在 merge/rebase/cherry-pick；请先完成或取消该操作。",
      );
    }
  }

  const sourceIndex = path.join(admin, "index");
  const lockPath = `${sourceIndex}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => {
    throw new Error("来源 index 正被使用，或遗留 index.lock；不会覆盖该锁。");
  });
  try {
    const head = await headAt(source, signal);
    const before = await regularFile(sourceIndex);
    await git(
      source,
      [
        "worktree",
        "add",
        "--lock",
        "--reason",
        "CodeAtelier managed overlay",
        ...(head
          ? ["--detach", "--no-checkout"]
          : ["--orphan", "-b", `codex/overlay-${id}`]),
        "--",
        staging,
        ...(head ? [head] : []),
      ],
      signal,
    );
    const adminDirectory = await git(
      staging,
      ["rev-parse", "--absolute-git-dir"],
      signal,
    );
    const worktreeConfig = path.join(admin, "config.worktree");
    if (await regularFile(worktreeConfig)) {
      await copyFile(
        worktreeConfig,
        path.join(adminDirectory, "config.worktree"),
      );
    }

    if (before) {
      await copyFile(sourceIndex, path.join(adminDirectory, "index"));
      const shared = await git(
        source,
        ["rev-parse", "--shared-index-path"],
        signal,
      );
      if (shared) {
        const sharedPath = path.resolve(source, shared);
        await regularFile(sharedPath);
        await copyFile(
          sharedPath,
          path.join(adminDirectory, path.basename(sharedPath)),
        );
      }

      await git(
        staging,
        [
          "update-index",
          "--no-split-index",
          "--no-fsmonitor",
          "--no-untracked-cache",
        ],
        signal,
      );
      const after = await stat(sourceIndex);
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error("捕获期间来源 index 改变；保留现场，不重试。");
      }
    } else {
      await git(staging, ["read-tree", "--empty"], signal);
      if (await regularFile(sourceIndex)) {
        throw new Error("捕获期间来源 index 改变。");
      }
    }

    if (head !== (await headAt(source, signal))) {
      throw new Error("捕获期间来源 HEAD 改变；保留现场。");
    }

    return {
      adminDirectory,
      commonDirectory,
      head,
      gitfile: await readFile(path.join(staging, ".git"), "utf8"),
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function attachOverlayGit(
  source: string,
  workspace: string,
  registration: OverlayGit,
  signal: AbortSignal,
) {
  await writeFile(path.join(workspace, ".git"), registration.gitfile, {
    flag: "wx",
  });
  await git(source, ["worktree", "repair", "--", workspace], signal);
  const backlink = (
    await readFile(path.join(registration.adminDirectory, "gitdir"), "utf8")
  ).trim();
  if (
    path.relative(path.resolve(backlink), path.join(workspace, ".git")) !== ""
  ) {
    throw new Error("Overlay Git backlink 未正确绑定；保留现场。");
  }
}
