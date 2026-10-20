/**
 * Broker 启动准备阶段读取当前工作目录下的宿主 Git 提交身份，供实例配置生成器调用。
 * 1. gitExecutable 仅从宿主 PATH 的绝对目录解析 Git，避免工作目录中的同名程序被隐式执行。
 * 2. readValue 以固定 argv 查询一个白名单键；Git 解析 include/includeIf 和 local/worktree 优先级。
 * 3. readHostGitIdentity 顺序读取 name/email，缺少 Git 或未配置字段不造默认身份；其它失败返回无正文错误。
 * 不执行 shell、helper、hook 或网络操作，不输出原始 stdout/stderr；每次查询有取消、5 秒时限和 64 KiB 上限。
 * 只读过程归入启动器已有 prepare_access/launch span；身份值不进入日志、trace 或 Runtime IPC。
 */

import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface HostGitIdentity {
  name?: string;
  email?: string;
}

async function gitExecutable(environment: NodeJS.ProcessEnv) {
  const searchPath = Object.entries(environment).find(([key]) =>
    process.platform === "win32"
      ? key.toLowerCase() === "path"
      : key === "PATH",
  )?.[1];
  for (const entry of (searchPath ?? "").split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, "");
    if (!path.isAbsolute(directory)) {
      continue;
    }

    const candidate = path.join(
      directory,
      process.platform === "win32" ? "git.exe" : "git",
    );
    try {
      if ((await stat(candidate)).isFile()) {
        await access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );

        return candidate;
      }
    } catch {
      // 不可用 PATH 项不是启动错误；不得退回在工作区寻找可执行文件。
    }
  }

  return undefined;
}

async function readValue(
  executable: string,
  workspace: string,
  key: "user.name" | "user.email",
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  try {
    const { stdout } = await execute(
      executable,
      [
        "-c",
        `safe.directory=${workspace.replaceAll(path.sep, "/")}`,
        "config",
        "--includes",
        "--null",
        "--get",
        key,
      ],
      {
        cwd: workspace,
        env: environment,
        signal,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    if (!stdout.endsWith("\0") || stdout.slice(0, -1).includes("\0")) {
      throw new Error("Invalid identity output");
    }

    return stdout.slice(0, -1);
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as { code?: unknown }).code === 1) {
      return undefined;
    }

    // execFile 的异常包含 argv/stdout/stderr，不能把原异常或 cause 交给启动日志。
    throw new Error("读取宿主 Git 提交身份失败；请检查宿主 Git 配置及可用性。");
  }
}

export async function readHostGitIdentity(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<HostGitIdentity> {
  signal?.throwIfAborted();
  const executable = await gitExecutable(environment);
  signal?.throwIfAborted();
  if (!executable) {
    return {};
  }

  // 保留宿主配置文件入口，但不继承其它仓库定位、命令级覆盖或 Git trace 文件输出。
  const configEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !/^GIT_/i.test(key) ||
        /^GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)$/i.test(key),
    ),
  );
  const identity: HostGitIdentity = {};
  const name = await readValue(
    executable,
    workspace,
    "user.name",
    configEnvironment,
    signal,
  );
  const email = await readValue(
    executable,
    workspace,
    "user.email",
    configEnvironment,
    signal,
  );
  if (name !== undefined) {
    identity.name = name;
  }

  if (email !== undefined) {
    identity.email = email;
  }

  return identity;
}
