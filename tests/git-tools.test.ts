/**
 * 验证单一 Git 工具的 action 契约、自动执行流程和固定命令序列，不启动真实 Git 进程或修改仓库。
 * 夹具使用临时工作区与注入的 GitExecutor：路径解析和敏感目录检查保持生产实现，子进程以记录调用的
 * 替身代替，因而不会产生提交、远程写入或真实凭据交互。
 *
 * 1. createFixture 模拟 worktree 根目录、当前分支及其安全 upstream，并记录 Git 参数和流式输出。
 * 2. 只读用例检查 status、diff、log、show、branch 的固定参数、路径和 revision 限制。
 * 3. 写入用例检查 add、commit、push 都无需审批，且 commit 仅暂存明确路径、暂存失败不继续提交。
 * 4. 安全用例拒绝敏感目录、未通过内容校验的 dotenv 模板、跨 worktree、危险 revision 与不安全 upstream，确保不能借 action 传递任意 Git 选项。
 *
 * 这些断言验证实际传给执行器的行为，而非只检查模型定义；真实 Git 与远程服务兼容性仍需手动集成验证。
 */

import { expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { ApprovalManager } from "../src/permissions/approval-manager.js";
import { SandboxBroker } from "../src/sandbox/broker.js";
import type { SandboxRuntime } from "../src/sandbox/types.js";
import {
  GitToolRunner,
  MAX_GIT_DIFF_OUTPUT_CHARS,
  type GitExecutor,
} from "../src/tools/git.js";
import { ToolRunner } from "../src/tools/tool-runner.js";
import { schemas } from "../src/tools/registry.js";
import { temp } from "./fixtures/helpers.js";

interface FixtureOptions {
  exitCodes?: number[];
  repositoryRoot?: string;
  remoteUrl?: string;
  diffOutput?: string;
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await temp();
  const config = new Config(await temp());
  const calls: string[][] = [];
  const output: string[] = [];
  const outputLimits: number[] = [];
  const exitCodes = [...(options.exitCodes ?? [])];
  const execute: GitExecutor = async (
    args,
    _cwd,
    _signal,
    _timeout,
    limit,
    emit,
  ) => {
    calls.push(args);
    outputLimits.push(limit);
    const command = args.join(" ");
    emit(command);

    const outputByCommand = new Map<string, string>([
      ["rev-parse --show-toplevel", options.repositoryRoot ?? root],
      ["symbolic-ref --quiet --short HEAD", "main"],
      ["config --get branch.main.remote", "origin"],
      ["config --get branch.main.merge", "refs/heads/main"],
      [
        "remote get-url --push origin",
        options.remoteUrl ?? "https://example.test/repo.git",
      ],
      ["rev-parse HEAD", "a".repeat(40)],
      [
        "--no-optional-locks diff --name-only -z --no-ext-diff --no-textconv --",
        "",
      ],
      [
        "--no-optional-locks diff --no-ext-diff --no-textconv --no-color --unified=3 -- .env.example",
        options.diffOutput ?? "",
      ],
      [
        "--no-optional-locks diff --no-ext-diff --no-textconv --no-color --unified=3 -- changed.ts",
        options.diffOutput ?? "",
      ],
    ]);

    const result = outputByCommand.get(command) ?? command;

    return {
      output: result.slice(0, limit),
      exitCode: exitCodes.shift() ?? 0,
      truncated: result.length > limit,
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

  return { root, calls, output, outputLimits, tools };
}

it("runs proactive read-only actions with fixed options", async () => {
  const fixture = await createFixture();

  await expect(
    fixture.tools.execute({ action: "status" }),
  ).resolves.toMatchObject({
    exitCode: 0,
  });
  await expect(
    fixture.tools.execute({
      action: "diff",
      staged: true,
      paths: ["changed.ts"],
      contextLines: 5,
    }),
  ).resolves.toMatchObject({ staged: true, paths: ["changed.ts"] });
  await expect(
    fixture.tools.execute({
      action: "log",
      revision: "HEAD",
      paths: [],
      limit: 3,
    }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    fixture.tools.execute({
      action: "show",
      revision: "main",
      paths: ["changed.ts"],
    }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    fixture.tools.execute({ action: "branch" }),
  ).resolves.toMatchObject({
    exitCode: 0,
  });

  expect(fixture.calls).toEqual([
    ["rev-parse", "--show-toplevel"],
    [
      "--no-optional-locks",
      "status",
      "--short",
      "--branch",
      "--untracked-files=normal",
    ],
    [
      "--no-optional-locks",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=5",
      "--cached",
      "--",
      "changed.ts",
    ],
    [
      "--no-optional-locks",
      "log",
      "--no-color",
      "--no-decorate",
      "--format=%H%x09%h%x09%s",
      "--max-count=3",
      "HEAD",
      "--",
    ],
    [
      "--no-optional-locks",
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--format=fuller",
      "main",
      "--",
      "changed.ts",
    ],
    [
      "--no-optional-locks",
      "branch",
      "--no-color",
      "--format=%(HEAD) %(refname:short) %(upstream:short)",
    ],
  ]);
  expect(fixture.output).toHaveLength(5);
});

it("routes every Git subprocess through the configured Sandbox Runtime", async () => {
  const root = await temp();
  const config = new Config(await temp());
  const calls: string[][] = [];
  const runtime: SandboxRuntime = {
    async selfCheck() {
      return {
        level: "test-sandbox",
        workspaceProtection: "direct-path",
      };
    },
    async execute(command) {
      calls.push(command.args);
      command.onProcessStarted(1234, "runtime");

      return {
        output:
          command.args.join(" ") === "rev-parse --show-toplevel"
            ? root
            : "## main",
        exitCode: 0,
        truncated: false,
      };
    },
  };
  const sandbox = new SandboxBroker(
    {
      enabled: true,
      initialStatus: {
        enabled: true,
        requested: true,
        applied: false,
        mode: "non-isolated",
        platform: process.platform,
        level: null,
      },
    },
    runtime,
  );
  const runner = new ToolRunner({
    root,
    sessionId: "session",
    taskId: "task",
    signal: new AbortController().signal,
    settings: config.settings,
    approvals: new ApprovalManager(() => {}),
    sandbox,
    emit: () => {},
  });

  await expect(
    runner.execute("git", { action: "status" }),
  ).resolves.toMatchObject({ exitCode: 0, output: "## main" });
  expect(calls).toEqual([
    ["rev-parse", "--show-toplevel"],
    [
      "--no-optional-locks",
      "status",
      "--short",
      "--branch",
      "--untracked-files=normal",
    ],
  ]);
});

it("caps long diff output independently from the general command output limit", async () => {
  const fixture = await createFixture({
    diffOutput: "x".repeat(MAX_GIT_DIFF_OUTPUT_CHARS + 1),
  });

  const result = await fixture.tools.execute({
    action: "diff",
    staged: false,
    paths: ["changed.ts"],
    contextLines: 3,
  });

  expect(fixture.outputLimits).toContain(MAX_GIT_DIFF_OUTPUT_CHARS);
  expect(result).toMatchObject({ truncated: true });
  expect(result.output).toHaveLength(MAX_GIT_DIFF_OUTPUT_CHARS);
});

it("automatically adds and commits only the specified workspace paths", async () => {
  const fixture = await createFixture();

  await writeFile(
    path.join(fixture.root, "changed.ts"),
    "export const changed = true;\n",
  );
  await expect(
    fixture.tools.execute({ action: "add", paths: ["changed.ts"] }),
  ).resolves.toMatchObject({ paths: ["changed.ts"], add: { exitCode: 0 } });
  const result = await fixture.tools.execute({
    action: "commit",
    message: "feat: add changed module",
    paths: ["changed.ts"],
  });

  expect(result.paths).toEqual(["changed.ts"]);
  expect(fixture.calls).toEqual([
    ["rev-parse", "--show-toplevel"],
    ["add", "--", "changed.ts"],
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
  const fixture = await createFixture({ exitCodes: [0, 1] });

  await writeFile(path.join(fixture.root, "changed.ts"), "changed\n");
  await expect(
    fixture.tools.execute({
      action: "commit",
      message: "fix: retain staging error",
      paths: ["changed.ts"],
    }),
  ).resolves.toMatchObject({
    stage: { exitCode: 1 },
    commit: null,
  });
  expect(fixture.calls).toEqual([
    ["rev-parse", "--show-toplevel"],
    ["add", "--", "changed.ts"],
  ]);
});

it("automatically pushes only the checked configured upstream", async () => {
  const fixture = await createFixture();

  await expect(
    fixture.tools.execute({ action: "push" }),
  ).resolves.toMatchObject({
    exitCode: 0,
  });
  expect(fixture.calls).toEqual([
    ["rev-parse", "--show-toplevel"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["config", "--get", "branch.main.remote"],
    ["config", "--get", "branch.main.merge"],
    ["remote", "get-url", "--push", "origin"],
    ["rev-parse", "HEAD"],
    ["push", "--porcelain", "origin", `${"a".repeat(40)}:refs/heads/main`],
  ]);
  expect(schemas.git.safeParse({ action: "push", force: true }).success).toBe(
    false,
  );
});

it("allows checked dotenv templates but rejects runtime and credential-bearing variants", async () => {
  const safe = await createFixture();
  await writeFile(
    path.join(safe.root, ".env.example"),
    "CODEATELIER_BASE_URL=https://api.example.test/v1\nCODEATELIER_API_KEY=\n",
  );

  await expect(
    safe.tools.execute({ action: "add", paths: [".env.example"] }),
  ).resolves.toMatchObject({ paths: [".env.example"], add: { exitCode: 0 } });
  expect(safe.calls).toEqual([
    ["rev-parse", "--show-toplevel"],
    ["add", "--", ".env.example"],
  ]);

  const unsafe = await createFixture();
  await writeFile(
    path.join(unsafe.root, ".env.example"),
    "CODEATELIER_API_KEY=not-a-placeholder\n",
  );
  await expect(
    unsafe.tools.execute({
      action: "diff",
      staged: false,
      paths: [".env.example"],
      contextLines: 3,
    }),
  ).rejects.toThrow("敏感变量");
  expect(unsafe.calls).toEqual([["rev-parse", "--show-toplevel"]]);

  const historical = await createFixture({
    diffOutput: "CODEATELIER_API_KEY=should-not-be-emitted\n",
  });
  await writeFile(
    path.join(historical.root, ".env.example"),
    "CODEATELIER_API_KEY=\n",
  );
  await expect(
    historical.tools.execute({
      action: "diff",
      staged: false,
      paths: [".env.example"],
      contextLines: 3,
    }),
  ).rejects.toThrow("敏感变量");
  expect(historical.output).toEqual([]);
});

it("rejects sensitive paths, dangerous revisions, foreign repositories and unsafe remotes", async () => {
  const fixture = await createFixture();
  await mkdir(path.join(fixture.root, "src"));
  await writeFile(path.join(fixture.root, "src", ".env"), "secret\n");

  await expect(
    fixture.tools.execute({ action: "add", paths: ["src"] }),
  ).rejects.toThrow("敏感");
  await expect(
    fixture.tools.execute({
      action: "show",
      revision: "HEAD~1;",
      paths: ["src"],
    }),
  ).rejects.toThrow("revision");
  expect(fixture.calls).toEqual([["rev-parse", "--show-toplevel"]]);

  const foreign = await createFixture({
    repositoryRoot: path.dirname(fixture.root),
  });
  await expect(foreign.tools.execute({ action: "status" })).rejects.toThrow(
    "完全一致",
  );

  const unsafeRemote = await createFixture({ remoteUrl: "ext::sh -c exploit" });
  await expect(unsafeRemote.tools.execute({ action: "push" })).rejects.toThrow(
    "HTTPS、SSH",
  );

  const credentialedRemote = await createFixture({
    remoteUrl: "https://token@example.test/repo.git",
  });
  await expect(
    credentialedRemote.tools.execute({ action: "push" }),
  ).rejects.toThrow("HTTPS、SSH");

  const insecureRemote = await createFixture({
    remoteUrl: "http://example.test/repo.git",
  });
  await expect(
    insecureRemote.tools.execute({ action: "push" }),
  ).rejects.toThrow("HTTPS、SSH");
});

it("keeps action schemas narrow and requires the action-specific fields", () => {
  expect(schemas.git.safeParse({ action: "diff" }).success).toBe(false);
  expect(
    schemas.git.parse({
      action: "diff",
      staged: false,
      paths: [],
      contextLines: 3,
    }),
  ).toEqual({ action: "diff", staged: false, paths: [], contextLines: 3 });
  expect(
    schemas.git.safeParse({ action: "commit", message: "x", paths: [] })
      .success,
  ).toBe(false);
  expect(schemas.git.safeParse({ action: "reset" }).success).toBe(false);
});
