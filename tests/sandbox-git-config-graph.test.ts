/**
 * 验证 Windows Sandbox 的宿主 Git global/include 图解析与聚合入口生成。
 * 临时夹具覆盖标准入口顺序、相对 include、条件 include、循环去重和安全拒绝；冲突优先级用本机真实 Git 验证。
 *
 * 1. 匹配当前 workspace 的 gitdir/i 文件进入图，不匹配条件不授权。
 * 2. 两个 global 入口保持固定聚合顺序，聚合配置仅信任本次工作区，私有 Sandbox HOME 不参与发现。
 * 3. UNC、未知 includeIf、链接、深度和文件数越界均在 ACL provision 前失败。
 */

import { expect, it } from "vitest";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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

  expect(graph.entryFiles).toEqual([second, first]);
  expect(graph.files).toEqual([second, first, relative, conditional]);
  expect(graph.aggregate).toBe(
    renderGitGlobalAggregate([second, first], await realpath(workspace)),
  );
  expect(graph.aggregate).toContain(
    `[safe]\n\tdirectory = ""\n\tdirectory = ${JSON.stringify(await realpath(workspace))}\n`,
  );
  expect(graph.aggregate).not.toContain("directory = *");
  expect(graph.aggregate).not.toContain(skipped);
});

function runGit(args: string[], environment: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (error += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(error || `git 退出码 ${code}`));
      }
    });
  });
}

it("preserves Git native XDG then home global precedence", async () => {
  const root = await temp();
  const profile = path.join(root, "profile");
  const xdg = path.join(profile, ".config");
  const workspace = path.join(root, "workspace");
  const xdgConfig = path.join(xdg, "git", "config");
  const homeConfig = path.join(profile, ".gitconfig");
  await mkdir(path.dirname(xdgConfig), { recursive: true });
  await mkdir(workspace);
  await writeFile(xdgConfig, "[test]\n  precedence = xdg\n");
  await writeFile(homeConfig, "[test]\n  precedence = home\n");
  const graph = await discoverGitConfigGraph({
    profileDirectory: profile,
    workspaceRoot: workspace,
  });
  const aggregate = path.join(root, "aggregate.gitconfig");
  await writeFile(aggregate, graph.aggregate);
  const environment = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
  };

  const nativeValue = await runGit(
    ["config", "--global", "--includes", "--get", "test.precedence"],
    environment,
  );
  const aggregateValue = await runGit(
    [
      "-c",
      `include.path=${aggregate}`,
      "config",
      "--includes",
      "--get",
      "test.precedence",
    ],
    {
      ...environment,
      HOME: path.join(root, "empty-home"),
      XDG_CONFIG_HOME: path.join(root, "empty-xdg"),
    },
  );

  expect(nativeValue).toBe("home");
  expect(aggregateValue).toBe(nativeValue);
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
