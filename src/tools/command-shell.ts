/**
 * 为模型只提供一条命令文本的 run_command 选择并封装本机 shell。
 * ToolRunner 在审批并执行普通命令前调用本模块；agent/instructions 为兼容测试重导出 Windows
 * 检测函数，模型永远不会收到可执行文件路径或固定前导参数。
 *
 * 1. WindowsShell 和候选表按 pwsh、Windows PowerShell、cmd 的确定顺序描述可用 shell。
 * 2. environmentValue、pathExecutables 与 detectWindowsShell 只检查服务进程可见的环境和真实文件，
 *    避免让模型通过命令探测或选择 shell。
 * 3. commandShell 为 Windows 返回检测结果；仅 Windows Sandbox inspect 模式固定传递 POSIX /bin/sh -c
 *    形状给 WSL Runtime；macOS、Linux 等 POSIX 平台固定使用已验证的 /bin/sh -c。
 *
 * 选择 shell 本身不放宽审批、路径或进程权限。调用方仍须将完整命令作为一次副作用申请授权，
 * 并在 shell 缺失时明确报告限制；本模块不执行任何命令。
 */

import { existsSync } from "node:fs";
import path from "node:path";

export interface CommandShell {
  command: string;
  args: string[];
}

interface ShellCandidate extends CommandShell {
  fallbackPaths: (environment: NodeJS.ProcessEnv) => string[];
}

const windowsShellCandidates: ShellCandidate[] = [
  {
    command: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    fallbackPaths: () => [],
  },
  {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    fallbackPaths: (environment) => {
      const systemRoot = environmentValue(environment, "SystemRoot");

      return systemRoot
        ? [
            path.win32.join(
              systemRoot,
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
          ]
        : [];
    },
  },
  {
    command: "cmd.exe",
    args: ["/d", "/s", "/c"],
    fallbackPaths: (environment) => {
      const comSpec = environmentValue(environment, "ComSpec");
      const systemRoot = environmentValue(environment, "SystemRoot");
      const fallbacks = comSpec ? [comSpec] : [];

      if (systemRoot) {
        fallbacks.push(path.win32.join(systemRoot, "System32", "cmd.exe"));
      }

      return fallbacks;
    },
  },
];

function environmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );

  return entry?.[1];
}

function pathExecutables(environment: NodeJS.ProcessEnv, executable: string) {
  const pathValue = environmentValue(environment, "Path");

  if (!pathValue) {
    return [];
  }

  return pathValue
    .split(";")
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((directory) => path.win32.resolve(directory, executable));
}

/** 仅在 Windows 选择第一个真实存在的候选 shell，并返回绝对路径。 */
export function detectWindowsShell(
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = existsSync,
  platform = process.platform,
): CommandShell | undefined {
  if (platform !== "win32") {
    return undefined;
  }

  for (const candidate of windowsShellCandidates) {
    const paths = [
      ...pathExecutables(environment, candidate.command),
      ...candidate
        .fallbackPaths(environment)
        .map((fallback) => path.win32.resolve(fallback)),
    ];
    const executablePath = paths.find(fileExists);

    if (executablePath) {
      return { command: executablePath, args: candidate.args };
    }
  }

  return undefined;
}

/**
 * 解析执行器使用的 shell；POSIX 的 /bin/sh 是 macOS/Linux 的稳定系统接口。
 * fileExists 可注入，供跨平台选择逻辑在单元测试中验证而不伪造进程平台。
 */
export function commandShell(
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = existsSync,
  platform = process.platform,
  sandboxEnabled = false,
): CommandShell | undefined {
  if (platform === "win32") {
    // WSL Runtime 在隔离根中执行这个固定形状；不能用宿主 shell 路径或其 Windows 语法。
    if (sandboxEnabled) {
      return { command: "/bin/sh", args: ["-c"] };
    }

    return detectWindowsShell(environment, fileExists, platform);
  }

  const shell = "/bin/sh";

  return fileExists(shell) ? { command: shell, args: ["-c"] } : undefined;
}
