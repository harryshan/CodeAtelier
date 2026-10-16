/**
 * 验证 Git CLI 通过通用 run_command 完成仓库操作，不依赖已移除的 Git action 执行器。
 * 使用临时仓库、显式测试身份与本地 bare remote，不连接网络、不读取个人 Git 配置。
 *
 * 1. fixture 组装真实 ToolRunner，收集审批和按 callId 归属的输出；测试环境覆盖在用例后恢复。
 * 2. sequence 按默认 PowerShell/POSIX shell 拼接同一逻辑阶段，任一 Git 非零即停止，减少重复 shell 启动。
 *    init/status/add/diff/commit/log/show/branch/push 观察真实仓库状态，非零退出按普通命令返回。
 * 3. 拒绝暂存命令后检查索引为空，证明普通 Git 写入没有免审批的旁路。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import { createTestRunner, temp } from "./fixtures/helpers.js";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await temp();
  const config = new Config(await temp());
  const globalConfig = path.join(root, "empty-config");
  await writeFile(globalConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
  const approval = vi.fn(async () => true);
  const events: Array<{ type: string; data: any }> = [];
  const runner = createTestRunner({
    root,
    sessionId: "git-cli-session",
    taskId: "git-cli-task",
    signal: new AbortController().signal,
    settings: config.settings,
    approvals: { request: approval },
    emit: (type, data) => events.push({ type, data }),
  });
  const execute = (command: string, callId = "cli-call") =>
    runner.forCall(callId).execute("run_command", { command });
  await expect(execute("git init -b main")).resolves.toMatchObject({
    exitCode: 0,
  });

  return { root, approval, events, execute };
}

function sequence(...commands: string[]) {
  // Windows 普通命令使用 PowerShell；不能依赖仅 PowerShell 7 支持的 &&。
  const separator =
    process.platform === "win32"
      ? "; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; "
      : " && ";

  return commands.join(separator);
}

it("performs Git reads, writes and a local push through ordinary command tools", async () => {
  const { root, approval, events, execute } = await fixture();
  await writeFile(path.join(root, "change.txt"), "reviewed content\n");
  expect((await execute("git status --short")).output).toContain("change.txt");
  const commit = await execute(
    sequence(
      "git add -- change.txt",
      "git --no-pager diff --cached -- change.txt",
      'git -c user.name=Test -c user.email=test@example.invalid -c commit.gpgSign=false commit -m "CLI change"',
    ),
    "commit-call",
  );
  expect(commit.exitCode).toBe(0);
  expect(commit.output).toContain("reviewed content");

  const reads = await execute(
    sequence(
      "git log -1 --format=%s",
      "git show HEAD:change.txt",
      "git branch --show-current",
    ),
  );
  expect(reads.exitCode).toBe(0);
  expect(reads.output.trim().split(/\r?\n/)).toEqual([
    "CLI change",
    "reviewed content",
    "main",
  ]);

  const push = await execute(
    sequence(
      "git init --bare remote.git",
      "git push ./remote.git HEAD:refs/heads/main",
    ),
  );
  expect(push.exitCode).toBe(0);
  const refs = await execute(
    sequence(
      "git rev-parse HEAD",
      "git --git-dir=remote.git rev-parse refs/heads/main",
    ),
  );
  expect(refs.exitCode).toBe(0);
  const objectIds = refs.output.trim().split(/\r?\n/);
  expect(objectIds).toHaveLength(2);
  expect(objectIds[0]).toMatch(/^[a-f0-9]{40,64}$/);
  expect(objectIds[1]).toBe(objectIds[0]);
  expect((await execute("git show missing-ref")).exitCode).not.toBe(0);
  expect(approval).toHaveBeenCalledTimes(7);
  expect(events).toContainEqual({
    type: "command_output",
    data: expect.objectContaining({
      callId: "commit-call",
      text: expect.stringContaining("CLI change"),
    }),
  });
  expect(events.some((event) => event.type === "git_output")).toBe(false);
});

it("does not stage a file after ordinary command approval is denied", async () => {
  const { root, approval, execute } = await fixture();
  await writeFile(path.join(root, "denied.txt"), "must remain untracked\n");
  approval.mockResolvedValueOnce(false);

  await expect(execute("git add -- denied.txt")).rejects.toThrow(
    "用户拒绝执行命令",
  );
  expect((await execute("git diff --cached --name-only")).output.trim()).toBe(
    "",
  );
});
