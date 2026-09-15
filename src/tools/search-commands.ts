/**
 * 检测服务进程当前可解析的代码搜索命令，供 agent/instructions 在模型请求前生成事实性提示。
 * 本模块不执行命令，也不返回可执行文件绝对路径；模型只能得到可在 run_command 中使用的稳定命令名。
 *
 * 1. SearchCandidate 列出常见内容及文件名搜索程序，按通用实现特征的估计性能排序。
 * 2. environmentValue 以大小写无关方式读取 Windows 环境变量；executablePaths 按目标平台的
 *    PATH 分隔符、路径解析和 Windows 可执行扩展名构造候选位置。
 * 3. detectSearchCommands 检查 PATH，并在 PowerShell 是选定 shell 时纳入 Select-String；Windows
 *    为系统自带 findstr 额外检查 SystemRoot/System32，返回实际可用的命令名和用途。
 *
 * 检测只是对当前进程环境的快照，不能绕过命令审批、赋予 PATH 外访问权限或保证命令在之后仍存在。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { detectWindowsShell } from "./command-shell.js";

export interface RepositorySearchTool {
  command: string;
  purpose: "content" | "filenames";
}

interface SearchCandidate extends RepositorySearchTool {
  /** 数值越小越优先；这是通用实现特征的估计，不替代目标项目上的实测。 */
  performanceRank: number;
  platforms?: NodeJS.Platform[];
  fallbackPaths?: (environment: NodeJS.ProcessEnv) => string[];
  available?: (
    environment: NodeJS.ProcessEnv,
    fileExists: (candidate: string) => boolean,
    platform: NodeJS.Platform,
  ) => boolean;
}

// 前面的工具通常并行遍历、尊重常见忽略文件，后面的工具强调可用性和平台自带能力。
const searchCandidates: SearchCandidate[] = [
  { command: "rg", purpose: "content", performanceRank: 1 },
  { command: "ugrep", purpose: "content", performanceRank: 2 },
  { command: "ag", purpose: "content", performanceRank: 3 },
  { command: "pt", purpose: "content", performanceRank: 4 },
  { command: "ack", purpose: "content", performanceRank: 5 },
  { command: "grep", purpose: "content", performanceRank: 6 },
  { command: "fd", purpose: "filenames", performanceRank: 7 },
  { command: "fdfind", purpose: "filenames", performanceRank: 8 },
  {
    command: "Select-String",
    purpose: "content",
    performanceRank: 9,
    platforms: ["win32"],
    available: (environment, fileExists, platform) => {
      const shell = detectWindowsShell(environment, fileExists, platform);

      return Boolean(shell && /(?:pwsh|powershell)\.exe$/i.test(shell.command));
    },
  },
  {
    command: "find",
    purpose: "filenames",
    performanceRank: 11,
    platforms: [
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "netbsd",
      "openbsd",
      "sunos",
    ],
  },
  {
    command: "findstr",
    purpose: "content",
    performanceRank: 10,
    platforms: ["win32"],
    fallbackPaths: (environment) => {
      const systemRoot = environmentValue(environment, "SystemRoot");

      return systemRoot
        ? [path.win32.join(systemRoot, "System32", "findstr.exe")]
        : [];
    },
  },
];

function environmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );

  return entry?.[1];
}

function executablePaths(
  environment: NodeJS.ProcessEnv,
  command: string,
  platform: NodeJS.Platform,
) {
  const pathValue = environmentValue(environment, "Path");

  if (!pathValue) {
    return [];
  }

  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const extensions = windows ? [".exe", ".cmd", ".bat"] : [""];

  return pathValue
    .split(windows ? ";" : ":")
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) =>
        pathApi.resolve(directory, command + extension),
      ),
    );
}

/** 返回当前环境可用于 run_command 的搜索命令，按估计性能排序且不泄露绝对路径。 */
export function detectSearchCommands(
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): RepositorySearchTool[] {
  return searchCandidates
    .filter(
      (candidate) =>
        (!candidate.platforms || candidate.platforms.includes(platform)) &&
        (candidate.available?.(environment, fileExists, platform) ??
          [
            ...executablePaths(environment, candidate.command, platform),
            ...(candidate.fallbackPaths?.(environment) ?? []),
          ].some(fileExists)),
    )
    .sort((left, right) => left.performanceRank - right.performanceRank)
    .map(({ command, purpose }) => ({ command, purpose }));
}
