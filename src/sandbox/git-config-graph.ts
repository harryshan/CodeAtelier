/**
 * 解析宿主 Git global 配置的 include/includeIf 文件图，供 Windows Sandbox AccessManifest 精确投影只读文件。
 * SandboxBroker 在 provision 前调用本模块；Runtime 中的 Git 仍自行解释完整配置，本解析器只决定必须授权哪些普通文件。
 *
 * 1. discoverGitConfigGraph 按标准 global 入口顺序读取现存文件，并递归处理 include.path 与适用于当前仓库的 gitdir/gitdir/i includeIf。
 * 2. 每个文件在读取前拒绝 UNC、设备路径和符号链接入口，以 realpath + stat 身份去重；循环、深度、数量和总字节都有硬上限。
 * 3. 相对 include 以声明它的配置文件目录解析，~/ 只展开为显式传入的宿主 profile，不读取 Sandbox HOME。
 * 4. renderGitGlobalAggregate 生成固定顺序的 include 入口，并仅信任本次真实工作区的 Git owner；调用方必须把结果放在 Runtime 不可写的投影父目录。
 *
 * 本模块不执行 Git、不解析 helper/url/proxy 等普通键，也不推导 push 目标。无法可靠理解的 includeIf 条件会拒绝 Sandbox preflight，
 * 而不是静默漏授权后改变用户 Git 配置语义。
 */

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_FILES = 32;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_BYTES = 512 * 1024;

export interface GitConfigGraphOptions {
  profileDirectory: string;
  workspaceRoot: string;
  entryFiles?: string[];
  maxFiles?: number;
  maxDepth?: number;
  maxBytes?: number;
}

export interface GitConfigGraph {
  entryFiles: string[];
  files: string[];
  aggregate: string;
}

export class GitConfigGraphError extends Error {
  readonly code = "SANDBOX_GIT_CONFIG_GRAPH";

  constructor(reason: string) {
    super(`Sandbox Git 配置图无效：${reason}`);
    this.name = "GitConfigGraphError";
  }
}

interface IncludeDirective {
  condition?: string;
  value: string;
}

function pathKey(value: string) {
  return process.platform === "win32" ? value.toLocaleLowerCase() : value;
}

function unsafeWindowsPath(value: string) {
  return (
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    /^\\\\[?.]\\/.test(value)
  );
}

function unquote(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) {
    return trimmed.replace(/\s+[;#].*$/, "").trim();
  }

  let result = "";
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      const mapped: Record<string, string> = {
        n: "\n",
        t: "\t",
        b: "\b",
        "\\": "\\",
        '"': '"',
      };
      if (!(character in mapped)) {
        throw new GitConfigGraphError("include 路径包含未知转义。");
      }

      result += mapped[character];
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      if (!/^\s*(?:[;#].*)?$/.test(trimmed.slice(index + 1))) {
        throw new GitConfigGraphError("include 路径引号后包含额外内容。");
      }

      return result;
    } else {
      result += character;
    }
  }

  throw new GitConfigGraphError("include 路径缺少结束引号。");
}

function parseIncludes(content: string) {
  const directives: IncludeDirective[] = [];
  let section = "";
  let subsection: string | undefined;
  let logicalLine = "";
  const lines = content.replace(/\r\n?/g, "\n").split("\n");

  for (const physical of lines) {
    logicalLine += physical;
    if (/\\$/.test(logicalLine) && !/\\\\$/.test(logicalLine)) {
      logicalLine = logicalLine.slice(0, -1);
      continue;
    }

    const line = logicalLine.trim();
    logicalLine = "";
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const header = line.match(
      /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]\s*(?:[;#].*)?$/,
    );
    if (header) {
      section = header[1]?.toLocaleLowerCase() ?? "";
      subsection = header[2]?.replace(/\\([\\"])/g, "$1");
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9.-]+)\s*(?:=\s*)?(.*)$/);
    if (!assignment) {
      throw new GitConfigGraphError("配置包含无法解析的语法。");
    }

    if (
      assignment[1]?.toLocaleLowerCase() === "path" &&
      (section === "include" || section === "includeif")
    ) {
      directives.push({
        condition: section === "includeif" ? subsection : undefined,
        value: unquote(assignment[2] ?? ""),
      });
    }
  }

  if (logicalLine) {
    throw new GitConfigGraphError("配置以未完成的续行结束。");
  }

  return directives;
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function gitdirPatternRegex(pattern: string, caseInsensitive: boolean) {
  let normalized = pattern.replace(/\\/g, "/");
  if (normalized.startsWith("~/")) {
    throw new GitConfigGraphError(
      "includeIf gitdir 不支持隐式宿主 HOME；请使用绝对或相对 glob。",
    );
  }

  if (!path.posix.isAbsolute(normalized) && !/^[A-Za-z]:\//.test(normalized)) {
    normalized = `**/${normalized}`;
  }

  if (normalized.endsWith("/")) {
    normalized += "**";
  }

  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";
    if (character === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(character);
    }
  }

  return new RegExp(`^${expression}$`, caseInsensitive ? "i" : undefined);
}

function conditionMatches(condition: string | undefined, gitDirectory: string) {
  if (!condition) {
    return true;
  }

  const separator = condition.indexOf(":");
  const keyword = condition.slice(0, separator).toLocaleLowerCase();
  const pattern = condition.slice(separator + 1);
  if (separator < 1 || !pattern) {
    throw new GitConfigGraphError("includeIf 条件为空或格式无效。");
  }

  if (keyword !== "gitdir" && keyword !== "gitdir/i") {
    throw new GitConfigGraphError(
      "当前只支持 gitdir/gitdir/i includeIf 条件。",
    );
  }

  return gitdirPatternRegex(pattern, keyword === "gitdir/i").test(
    gitDirectory.replace(/\\/g, "/"),
  );
}

function resolveInclude(
  value: string,
  declaringFile: string,
  profileDirectory: string,
) {
  if (!value || unsafeWindowsPath(value)) {
    throw new GitConfigGraphError("include 路径为空、UNC 或设备路径。");
  }

  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(profileDirectory, value.slice(2));
  }

  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(path.dirname(declaringFile), value);
}

async function openStableFile(input: string) {
  if (unsafeWindowsPath(input)) {
    throw new GitConfigGraphError("配置文件不能使用 UNC 或设备路径。");
  }

  let lexical: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    lexical = await lstat(input);
    canonical = await realpath(input);
    info = await stat(canonical);
  } catch {
    throw new GitConfigGraphError("已引用的配置文件不存在或无法打开。");
  }

  if (lexical.isSymbolicLink() || !info.isFile()) {
    throw new GitConfigGraphError("配置对象必须是非链接普通文件。");
  }

  return canonical;
}

function quoteGitPath(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderGitGlobalAggregate(
  entryFiles: string[],
  workspaceRoot: string,
) {
  const includes = entryFiles
    .map((file) => `[include]\n\tpath = ${quoteGitPath(file)}\n`)
    .join("");

  // 先清空宿主或系统配置可能继承的通配值，再只信任当前真实工作区。
  // 专用账户不拥有宿主工作区，Git 否则会在读取仓库配置前拒绝执行。
  return `${includes}[safe]\n\tdirectory = ""\n\tdirectory = ${quoteGitPath(workspaceRoot)}\n`;
}

/** 返回真实、稳定且有界的文件图；不存在的标准入口由调用方在传入前过滤。 */
export async function discoverGitConfigGraph(
  options: GitConfigGraphOptions,
): Promise<GitConfigGraph> {
  const maximumFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maximumDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maximumBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const entryInputs = options.entryFiles ?? [
    path.join(options.profileDirectory, ".config", "git", "config"),
    path.join(options.profileDirectory, ".gitconfig"),
  ];
  const workspaceRoot = await realpath(options.workspaceRoot);
  const gitDirectory = path
    .join(workspaceRoot, ".git")
    .replace(/\\/g, "/")
    .concat("/");
  const existingEntries: string[] = [];
  for (const entry of entryInputs) {
    try {
      existingEntries.push(await openStableFile(entry));
    } catch (error) {
      if (error instanceof GitConfigGraphError) {
        try {
          await lstat(entry);
        } catch {
          continue;
        }
      }

      throw error;
    }
  }

  const files: string[] = [];
  const visited = new Set<string>();
  let totalBytes = 0;
  const visit = async (input: string, depth: number): Promise<void> => {
    if (depth > maximumDepth) {
      throw new GitConfigGraphError("include 深度超过限制。");
    }

    const file = await openStableFile(input);
    const key = pathKey(file);
    if (visited.has(key)) {
      return;
    }

    if (visited.size >= maximumFiles) {
      throw new GitConfigGraphError("配置文件数量超过限制。");
    }

    const content = await readFile(file, "utf8");
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > maximumBytes) {
      throw new GitConfigGraphError("配置图总字节数超过限制。");
    }

    visited.add(key);
    files.push(file);

    for (const directive of parseIncludes(content)) {
      if (conditionMatches(directive.condition, gitDirectory)) {
        await visit(
          resolveInclude(directive.value, file, options.profileDirectory),
          depth + 1,
        );
      }
    }
  };

  for (const entry of existingEntries) {
    await visit(entry, 0);
  }

  return {
    entryFiles: existingEntries,
    files,
    aggregate: renderGitGlobalAggregate(existingEntries, workspaceRoot),
  };
}
