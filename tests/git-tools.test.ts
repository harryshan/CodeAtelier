/**
 * 验证专用 Git 工具的参数边界、自动执行流程和固定命令序列，不启动真实 Git 进程或修改仓库。
 * 夹具使用临时工作区与注入的 GitExecutor：路径解析保持生产实现，子进程以记录调用的替身代替，
 * 避免测试产生 commit、push 或远程写入。
 *
 * 1. createFixture 组装 GitToolRunner、临时设置和记录 Git 参数的执行器。
 * 2. 只读用例检查 status/diff 的固定参数。
 * 3. 写入用例检查 commit/push 不等待审批即可执行、提交仅暂存明确路径、失败不继续提交。
 * 4. 路径与 schema 用例拒绝敏感文件和额外参数，确保不能借专用工具传递任意 Git 选项。
 *
 * 这些断言验证工具实际传给执行器的行为，而非只检查模型定义；真实 Git 兼容性仍需在
 * 用户明确要求的手动集成验证中完成。
 */

import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { GitToolRunner, type GitExecutor } from "../src/tools/git.js";
import { schemas } from "../src/tools/registry.js";
import { temp } from "./fixtures/helpers.js";

async function createFixture(exitCodes: number[] = []) {
  const root = await temp();
  const config = new Config(await temp());
  const calls: string[][] = [];
  const output: string[] = [];
  const execute: GitExecutor = async (
    args,
    _cwd,
    _signal,
    _timeout,
    _limit,
    emit,
  ) => {
    calls.push(args);
    emit(args.join(" "));

    return {
      output: args.join(" "),
      exitCode: exitCodes.shift() ?? 0,
      truncated: false,
    };
  };

  const tools = new GitToolRunner(
    {
      root,
      sessionId: "session",
      taskId: "task",
      signal: new AbortController().signal,
      settings: config.settings,
      emit: (type, data) => {
        if (type === "git_output") {
          output.push(data.text);
        }
      },
    },
    execute,
  );

  return { root, calls, output, tools };
}

it("runs fixed read-only status and diff commands", async () => {
  const fixture = await createFixture();

  expect(await fixture.tools.execute("git_status", {})).toMatchObject({
    exitCode: 0,
  });
  expect(
    await fixture.tools.execute("git_diff", { staged: true }),
  ).toMatchObject({
    staged: true,
    exitCode: 0,
  });

  expect(fixture.calls).toEqual([
    ["status", "--short", "--branch"],
    ["diff", "--no-ext-diff", "--cached"],
  ]);
  expect(fixture.output).toEqual([
    "status --short --branch",
    "diff --no-ext-diff --cached",
  ]);
});

it("automatically commits only the specified workspace paths", async () => {
  const fixture = await createFixture();

  await writeFile(
    path.join(fixture.root, "changed.ts"),
    "export const changed = true;\n",
  );
  const result = await fixture.tools.execute("git_commit", {
    message: "feat: add changed module",
    paths: ["changed.ts"],
  });

  expect(result.paths).toEqual(["changed.ts"]);
  expect(fixture.calls).toEqual([
    ["add", "--", "changed.ts"],
    [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--only",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      "feat: add changed module",
      "--",
      "changed.ts",
    ],
  ]);
});

it("does not attempt a commit when staging fails", async () => {
  const fixture = await createFixture([1]);

  await writeFile(path.join(fixture.root, "changed.ts"), "changed\n");
  await expect(
    fixture.tools.execute("git_commit", {
      message: "fix: retain staging error",
      paths: ["changed.ts"],
    }),
  ).resolves.toMatchObject({
    stage: { exitCode: 1 },
    commit: null,
  });
  expect(fixture.calls).toEqual([["add", "--", "changed.ts"]]);
});

it("automatically pushes only to the configured upstream and permits no options", async () => {
  const fixture = await createFixture();

  await expect(fixture.tools.execute("git_push", {})).resolves.toMatchObject({
    exitCode: 0,
  });
  expect(fixture.calls).toEqual([["push", "--porcelain"]]);
  expect(() => schemas.git_push.parse({ force: true })).toThrow();
});

it("rejects sensitive commit paths before execution", async () => {
  const fixture = await createFixture();

  await expect(
    fixture.tools.execute("git_commit", {
      message: "chore: should not commit credentials",
      paths: [".env"],
    }),
  ).rejects.toThrow("非敏感");
  expect(fixture.calls).toEqual([]);
  expect(() => schemas.git_commit.parse({ message: "x", paths: [] })).toThrow();
});
