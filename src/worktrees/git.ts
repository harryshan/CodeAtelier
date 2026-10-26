/**
 * 为显式 Worktree UI 操作执行固定的本地 Git 命令，供 WorktreeService 调用。
 * 1. git 使用 execFile 参数数组查询；addWorktree 复用 executeProcess 的进程树取消，供显式 Git 模式建立 detached checkout。
 *    gitEnvironment 为管理命令和宿主 helper 清除继承 GIT 环境，禁用交互、管理 hooks 和 submodule recurse。
 * 2. 输出有容量和时间上限；取消/失败只返回受控错误，不将过滤器输出或配置写入日志。
 * 3. directoryIdentity / samePath 核验真实目录与文件系统身份，拒绝被替换的 checkout。
 * 不直接调用 shell/fetch/pull，也不自动重试或清理；Git 自身的 checkout filters 仍可运行。普通模型 Git 命令不经过本模块。
 */

import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { executeProcess } from "../tools/process.js";

const execute = promisify(execFile);

function gitArguments(args: string[]) {
  return [
    "-c",
    "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
    "-c",
    "submodule.recurse=false",
    ...args,
  ];
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.toUpperCase().startsWith("GIT_"))
        .map((key) => [key, undefined]),
    ),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_KEY_1: "submodule.recurse",
    GIT_CONFIG_VALUE_1: "false",
  };
}

/** Only explicit UI creation uses this mutating path; never auto-retry an unknown checkout. */
export async function addWorktree(
  source: string,
  destination: string,
  commit: string,
  signal: AbortSignal,
  noCheckout = false,
) {
  try {
    const result = await executeProcess(
      "git",
      gitArguments([
        "worktree",
        "add",
        "--detach",
        ...(noCheckout ? ["--no-checkout"] : []),
        "--",
        destination,
        commit,
      ]),
      source,
      signal,
      600_000,
      1024 * 1024,
      () => {},
      gitEnvironment(),
    );
    if (result.exitCode !== 0) {
      throw new Error("git failed");
    }
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "Git 创建 Worktree 失败或超时；保留现场，请检查仓库和创建清单，不会自动重试。",
    );
  }
}

export function samePath(left: string, right: string) {
  return path.relative(left, right) === "";
}

export async function directoryIdentity(directory: string) {
  const resolved = await realpath(directory);
  const info = await stat(directory, { bigint: true });
  if (
    !info.isDirectory() ||
    (await lstat(directory)).isSymbolicLink() ||
    !samePath(resolved, path.resolve(directory))
  ) {
    throw new Error("Worktree 目录不能是链接或已被重定向的路径。");
  }

  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

export async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  try {
    const result = await execute("git", gitArguments(args), {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      signal,
    });

    return result.stdout.trim();
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? "找不到 Git，请安装 Git 并重新启动服务。"
        : "Git worktree 操作失败；请检查基线、仓库权限和本机 Git 状态。操作不会自动重试。",
    );
  }
}
