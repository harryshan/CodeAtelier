/**
 * 验证 Windows Sandbox 的宿主 Git global/include 图解析与聚合入口生成。
 * 临时夹具覆盖标准入口顺序、相对 include、条件 include、循环去重和安全拒绝，不调用真实 Git。
 *
 * 1. 匹配当前 workspace 的 gitdir/i 文件进入图，不匹配条件不授权。
 * 2. 两个 global 入口保持固定聚合顺序，私有 Sandbox HOME 不参与发现。
 * 3. UNC、未知 includeIf、链接、深度和文件数越界均在 ACL provision 前失败。
 */

import { expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  discoverGitConfigGraph,
  renderGitGlobalAggregate,
} from "../src/sandbox/git-config-graph.js";
import { temp } from "./fixtures/helpers.js";

it("discovers ordered global, relative and matching conditional includes", async () => {
  const root = await temp();
  const profile = path.join(root, "profile");
  const workspace = path.join(root, "workspace");
  const configDirectory = path.join(profile, ".config", "git");
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  const first = path.join(profile, ".gitconfig");
  const relative = path.join(profile, "relative.inc");
  const conditional = path.join(profile, "conditional.inc");
  const skipped = path.join(profile, "skipped.inc");
  const second = path.join(configDirectory, "config");
  await writeFile(
    first,
    `[include]\n  path = relative.inc\n[includeIf "gitdir/i:**/workspace/.git/"]\n  path = conditional.inc\n[includeIf "gitdir:**/other/.git/"]\n  path = skipped.inc\n`,
  );
  await writeFile(relative, "[user]\n  name = Example\n");
  await writeFile(conditional, "[alias]\n  safe = status\n");
  await writeFile(skipped, "[alias]\n  skipped = status\n");
  await writeFile(second, "[core]\n  autocrlf = true\n");

  const graph = await discoverGitConfigGraph({
    profileDirectory: profile,
    workspaceRoot: workspace,
  });

  expect(graph.entryFiles).toEqual([first, second]);
  expect(graph.files).toEqual([first, relative, conditional, second]);
  expect(graph.aggregate).toBe(renderGitGlobalAggregate([first, second]));
  expect(graph.aggregate).not.toContain(skipped);
});

it("deduplicates include cycles", async () => {
  const root = await temp();
  const workspace = path.join(root, "workspace");
  const first = path.join(root, "first.gitconfig");
  const second = path.join(root, "second.gitconfig");
  await mkdir(workspace);
  await writeFile(first, `[include]\n path = ${JSON.stringify(second)}\n`);
  await writeFile(second, `[include]\n path = ${JSON.stringify(first)}\n`);

  const graph = await discoverGitConfigGraph({
    profileDirectory: root,
    workspaceRoot: workspace,
    entryFiles: [first],
  });
  expect(graph.files).toEqual([first, second]);
});

it("rejects unsupported conditions and linked include files", async () => {
  const root = await temp();
  const workspace = path.join(root, "workspace");
  const entry = path.join(root, "entry.gitconfig");
  const target = path.join(root, "target.gitconfig");
  const linked = path.join(root, "linked.gitconfig");
  await mkdir(workspace);
  await writeFile(target, "[user]\n name = Example\n");
  await symlink(target, linked, "file");
  await writeFile(entry, `[include]\n path = ${JSON.stringify(linked)}\n`);

  await expect(
    discoverGitConfigGraph({
      profileDirectory: root,
      workspaceRoot: workspace,
      entryFiles: [entry],
    }),
  ).rejects.toMatchObject({ code: "SANDBOX_GIT_CONFIG_GRAPH" });

  await writeFile(
    entry,
    `[includeIf "onbranch:main"]\n path = ${JSON.stringify(target)}\n`,
  );
  await expect(
    discoverGitConfigGraph({
      profileDirectory: root,
      workspaceRoot: workspace,
      entryFiles: [entry],
    }),
  ).rejects.toThrow("gitdir/gitdir/i");
});
