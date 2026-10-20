/**
 * 验证两个 Sandbox 启动器共用的实例级 Git 信任配置，不修改真实用户 Git 配置。
 * 1. 临时目录覆盖普通仓库、gitfile/worktree、裸库、非仓库以及缺失目录失败。
 * 2. 使用真实 Git 解析含空格/特殊字符路径；通过 Git 测试开关模拟 owner 不一致并验证 status 恢复。
 * 3. 配置只授予当前路径：另一个仓库仍被拒绝，非仓库不继承父目录信任。
 * 所有写入局限于自动清理的测试临时目录；不改变 owner/ACL，不运行原生 Sandbox 或远程命令。
 */

import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { workspaceGitConfig } from "../src/sandbox/git-workspace-trust.js";
import { temp } from "./fixtures/helpers.js";

const execute = promisify(execFile);

it.each(["directory", "gitfile", "bare"])(
  "recognizes %s without reading host configuration",
  async (kind) => {
    const root = await temp();
    if (kind === "directory") {
      await mkdir(path.join(root, ".git"));
    } else if (kind === "gitfile") {
      await writeFile(path.join(root, ".git"), "gitdir: ../metadata\n");
    } else {
      await writeFile(path.join(root, "HEAD"), "ref: refs/heads/main\n");
      await mkdir(path.join(root, "objects"));
      await writeFile(path.join(root, "config"), "[core]\n\tbare = true\n");
    }

    expect(await workspaceGitConfig(root)).toContain('[safe]\n\tdirectory = "');
  },
);

it("does not trust non-repositories, incomplete bare layouts or parent repositories", async () => {
  const root = await temp();
  expect(await workspaceGitConfig(root)).toBe("");
  await writeFile(path.join(root, "HEAD"), "unrelated");
  expect(await workspaceGitConfig(root)).toBe("");
  await mkdir(path.join(root, ".git"));
  const child = path.join(root, "child");
  await mkdir(child);
  expect(await workspaceGitConfig(child)).toBe("");
  await expect(
    workspaceGitConfig(path.join(root, "missing")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("restores Git access for a differently owned workspace without trusting another repository", async () => {
  const root = await temp();
  const name =
    process.platform === "win32"
      ? "repo space #; 中文"
      : 'repo space #; 中文 "\\\t\n';
  const workspace = path.join(root, name);
  const other = path.join(root, "other");
  const global = path.join(root, "global.gitconfig");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
  };
  await writeFile(global, "");
  await execute("git", ["init", workspace], { env });
  await execute("git", ["init", other], { env });
  await expect(
    execute("git", ["-C", workspace, "status", "--porcelain"], { env }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("dubious ownership"),
  });

  await writeFile(global, await workspaceGitConfig(workspace));
  const config = await execute(
    "git",
    ["config", "--global", "--get-all", "safe.directory"],
    { env },
  );
  const canonical = await realpath(workspace);
  expect(config.stdout).toBe(
    `${process.platform === "win32" ? canonical.replaceAll("\\", "/") : canonical}\n`,
  );
  expect(
    (await execute("git", ["-C", workspace, "status", "--porcelain"], { env }))
      .stdout,
  ).toBe("");
  await expect(
    execute("git", ["-C", other, "status", "--porcelain"], { env }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("dubious ownership"),
  });
});
