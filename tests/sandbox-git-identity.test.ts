/**
 * 离线验证 Broker 仅将宿主 Git 姓名/邮箱复制到实例配置，不复制认证或签名材料。
 * 1. fixture 使用隔离 HOME/global/system 与真实 Git 临时仓库，屏蔽开发者配置和身份环境。
 * 2. includeIf、仓库覆盖、空/缺失字段和特殊字符通过 Git 自身解析，最后真实提交核对 author/committer。
 * 3. 缺少 Git、取消、损坏配置只返回受控失败，不在异常中暴露宿主配置或 stderr。
 * 不联网，不调用 credential helper，不修改真实用户配置；夹具由统一 temp 生命周期清理。
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { sandboxGitConfig } from "../src/sandbox/sandbox-git-config.js";
import { readHostGitIdentity } from "../src/sandbox/host-git-identity.js";
import { temp } from "./fixtures/helpers.js";

const execute = promisify(execFile);

async function fixture() {
  const root = await temp();
  const workspace = path.join(root, "workspace");
  const global = path.join(root, "host.gitconfig");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_|^EMAIL$/i.test(key)),
  );
  Object.assign(environment, {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  });
  await writeFile(global, "");
  await execute("git", ["init", workspace], { env: environment });
  const git = (...args: string[]) =>
    execute("git", ["-C", workspace, ...args], { env: environment });

  return { root, workspace, global, environment, git };
}

it("uses includeIf identity and local overrides without projecting authentication or signing", async () => {
  const f = await fixture();
  const include = path.join(f.root, "identity.gitconfig");
  const name = 'Example "Author" \\ Team';
  await f.git("config", "--file", include, "user.name", name);
  await f.git(
    "config",
    "--file",
    include,
    "user.email",
    "included@example.invalid",
  );
  await f.git("config", "--global", "user.name", "Fallback");
  await f.git(
    "config",
    "--global",
    `includeIf.gitdir:${f.workspace.replaceAll("\\", "/")}/.git.path`,
    include.replaceAll("\\", "/"),
  );
  await f.git("config", "--global", "credential.helper", "!never-execute-me");
  await f.git(
    "config",
    "--global",
    "http.extraHeader",
    "Authorization: private-fixture",
  );
  await f.git("config", "--global", "user.signingKey", "private-signing-key");
  await f.git("config", "user.email", "local@example.invalid");
  const original = await readFile(f.global, "utf8");
  const projected = await sandboxGitConfig(f.workspace, {
    environment: f.environment,
  });
  expect(projected).not.toMatch(
    /credential|Authorization|private-fixture|signing|includeIf/,
  );
  expect(await readFile(f.global, "utf8")).toBe(original);

  // 删除 local 值后证明实例配置本身已保存工作区解析结果，而非偶然继续依赖 local。
  await f.git("config", "--unset", "user.email");
  const runtimeGlobal = path.join(f.root, "runtime.gitconfig");
  await writeFile(runtimeGlobal, projected);
  const runtimeEnv = {
    ...f.environment,
    GIT_CONFIG_GLOBAL: runtimeGlobal,
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
  };
  await execute(
    "git",
    [
      "-C",
      f.workspace,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Identity fixture",
    ],
    { env: runtimeEnv },
  );
  const commit = await execute(
    "git",
    ["-C", f.workspace, "log", "-1", "--format=%an%n%ae%n%cn%n%ce"],
    { env: runtimeEnv },
  );
  expect(commit.stdout).toBe(
    `${name}\nlocal@example.invalid\n${name}\nlocal@example.invalid\n`,
  );
});

it("keeps absent fields absent, empty values explicit, and projects identity for a non-repository", async () => {
  const f = await fixture();
  expect(await readHostGitIdentity(f.workspace, f.environment)).toEqual({});
  await f.git("config", "--global", "user.name", "");
  expect(await readHostGitIdentity(f.workspace, f.environment)).toEqual({
    name: "",
  });
  await f.git("config", "--global", "user.email", "only@example.invalid");
  const directory = path.join(f.root, "new-project");
  await mkdir(directory);
  const config = await sandboxGitConfig(directory, {
    environment: f.environment,
  });
  expect(config).toContain('name = ""');
  expect(config).toContain('email = "only@example.invalid"');
  expect(config).not.toContain("safe");
});

it("reads real worktree overrides and ignores inherited repository redirects and command configuration", async () => {
  const f = await fixture();
  await f.git("config", "--global", "user.name", "Worktree Author");
  await f.git("config", "--global", "user.email", "base@example.invalid");
  await f.git(
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "Base",
  );
  const worktree = path.join(f.root, "linked");
  await f.git("worktree", "add", "--detach", worktree);
  await f.git("config", "extensions.worktreeConfig", "true");
  await execute(
    "git",
    [
      "-C",
      worktree,
      "config",
      "--worktree",
      "user.email",
      "worktree@example.invalid",
    ],
    { env: f.environment },
  );
  const identity = await readHostGitIdentity(worktree, {
    ...f.environment,
    GIT_DIR: path.join(f.root, "missing.git"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Injected Author",
    GIT_CONFIG_PARAMETERS: "invalid inherited options",
  });
  expect(identity).toEqual({
    name: "Worktree Author",
    email: "worktree@example.invalid",
  });
});

it("round trips multiline identity without injecting configuration and rejects excessive output", async () => {
  const f = await fixture();
  const name = "Author\\\t\n[credential]\nhelper = injected";
  await f.git("config", "--global", "user.name", name);
  const projected = path.join(f.root, "projected.gitconfig");
  await writeFile(
    projected,
    await sandboxGitConfig(f.workspace, { environment: f.environment }),
  );
  expect(
    (await f.git("config", "--file", projected, "--null", "--get", "user.name"))
      .stdout,
  ).toBe(`${name}\0`);
  await expect(
    f.git("config", "--file", projected, "--get", "credential.helper"),
  ).rejects.toMatchObject({ code: 1 });
  await writeFile(f.global, `[user]\nname = "${"x".repeat(70_000)}"\n`);
  await expect(readHostGitIdentity(f.workspace, f.environment)).rejects.toThrow(
    "读取宿主 Git 提交身份失败",
  );
});

it("tolerates missing Git but does not hide cancellation or disclose malformed configuration", async () => {
  const f = await fixture();
  const withoutPath = Object.fromEntries(
    Object.entries(f.environment).filter(
      ([key]) => key.toLowerCase() !== "path",
    ),
  );
  expect(await readHostGitIdentity(f.workspace, withoutPath)).toEqual({});
  const controller = new AbortController();
  controller.abort();
  await expect(
    readHostGitIdentity(f.workspace, f.environment, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  await writeFile(f.global, "[private-fixture-secret\n");
  await expect(readHostGitIdentity(f.workspace, f.environment)).rejects.toThrow(
    "读取宿主 Git 提交身份失败",
  );
  try {
    await readHostGitIdentity(f.workspace, f.environment);
  } catch (error) {
    expect(String(error)).not.toContain("private-fixture-secret");
    expect((error as Error).cause).toBeUndefined();
  }
});
