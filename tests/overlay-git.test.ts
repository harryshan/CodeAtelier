/**
 * 用独占的真实 Git 夹具验证 overlay 的 linked worktree metadata，不依赖 WinFsp。
 * 1. 登记不 checkout 项目文件，复制 staged index 后绑定另一空目录，验证 Git 官方 backlink。
 * 2. task commit 保持来源 HEAD/index/dirty 文件，objects/普通 refs 按 worktree 共享。
 * 3. 覆盖 split-index、无提交仓库、index.lock 和不支持的配置；不把夹具写入当成 overlay 证据。
 * 所有目录由测试资源容器管理；不修改个人 Git 配置或用户项目。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  attachOverlayGit,
  registerOverlayGit,
} from "../src/worktrees/overlay-git.js";
import { git, samePath } from "../src/worktrees/git.js";
import { temp } from "./fixtures/helpers.js";

async function fixture(commit = true) {
  const root = await temp();
  const source = path.join(root, "source");
  const staging = path.join(root, "registration");
  const workspace = path.join(root, "view");
  await mkdir(source);
  await mkdir(workspace);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Overlay fixture"]);
  await git(source, ["config", "user.email", "overlay@example.invalid"]);
  await writeFile(path.join(source, "file"), "base\n");
  await git(source, ["add", "."]);
  if (commit) {
    await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  }

  await writeFile(path.join(source, "file"), "staged\n");
  await git(source, ["add", "file"]);
  await writeFile(path.join(source, "file"), "dirty\n");
  const signal = new AbortController().signal;
  const register = () =>
    registerOverlayGit(source, staging, randomUUID(), signal);

  return { source, staging, workspace, signal, register };
}

it("registers metadata only and shares objects while keeping HEAD and index independent", async () => {
  const f = await fixture();
  const beforeHead = await git(f.source, ["rev-parse", "HEAD"]);
  const beforeIndex = await readFile(path.join(f.source, ".git", "index"));
  const registration = await f.register();
  expect(await readdir(f.staging)).toEqual([".git"]);
  expect(
    samePath(registration.commonDirectory, path.join(f.source, ".git")),
  ).toBe(true);
  await attachOverlayGit(f.source, f.workspace, registration, f.signal);
  // Only this fixture file represents the view; native integration has a separate verifier.
  await writeFile(path.join(f.workspace, "file"), "dirty\n");
  expect(await git(f.workspace, ["status", "--porcelain"])).toBe("MM file");
  expect(await git(f.workspace, ["show", ":file"])).toBe("staged");
  await git(f.workspace, ["add", "file"]);
  await git(f.workspace, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "task",
  ]);
  const taskHead = await git(f.workspace, ["rev-parse", "HEAD"]);
  expect(await git(f.source, ["cat-file", "-t", taskHead])).toBe("commit");
  await git(f.workspace, ["branch", "shared-fixture"]);
  expect(await git(f.source, ["rev-parse", "shared-fixture"])).toBe(taskHead);
  expect(await git(f.source, ["rev-parse", "HEAD"])).toBe(beforeHead);
  expect(await readFile(path.join(f.source, ".git", "index"))).toEqual(
    beforeIndex,
  );
  expect(await readFile(path.join(f.source, "file"), "utf8")).toBe("dirty\n");
});

it("expands a copied split-index without changing the source index", async () => {
  const f = await fixture();
  await git(f.source, ["update-index", "--split-index"]);
  const before = await readFile(path.join(f.source, ".git", "index"));
  await f.register();
  expect(await git(f.staging, ["show", ":file"])).toBe("staged");
  expect(await git(f.staging, ["rev-parse", "--shared-index-path"])).toBe("");
  expect(await readFile(path.join(f.source, ".git", "index"))).toEqual(before);
});

it("preserves staged data from an unborn source without creating a source commit", async () => {
  const f = await fixture(false);
  const registration = await f.register();
  expect(registration.head).toBe("");
  expect(await git(f.staging, ["show", ":file"])).toBe("staged");
  await expect(
    git(f.source, ["rev-parse", "--verify", "HEAD"]),
  ).rejects.toThrow();
  expect(await git(f.source, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
});

it("does not replace another writer's index.lock or begin registration", async () => {
  const f = await fixture();
  const lock = path.join(f.source, ".git", "index.lock");
  await writeFile(lock, "other writer");
  await expect(f.register()).rejects.toThrow("index.lock");
  expect(await readFile(lock, "utf8")).toBe("other writer");
  await expect(readdir(f.staging)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["core.sparsecheckout", "core.fsmonitor"])(
  "rejects %s before registering",
  async (key) => {
    const f = await fixture();
    await git(f.source, ["config", key, "true"]);
    await expect(f.register()).rejects.toThrow("暂不支持");
    await expect(readdir(f.staging)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
