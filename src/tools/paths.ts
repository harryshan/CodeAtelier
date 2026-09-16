/**
 * 统一解析工作区路径，判断是否越界、是否敏感，以及目标能否按普通文件读取。
 * ToolRunner、项目规则加载和创建会话的接口都会调用这里的函数。
 *
 * 1. inside 用相对路径判断目录关系，区分子目录和名字前缀相同的兄弟目录。
 * 2. canonical 解析已有路径的真实位置；目标尚未创建时，从已有父目录继续解析。
 * 3. sensitive 和 resolveTarget 标记普通文件访问应保守处理的敏感路径；pathRisk 额外区分 Git 可校验的 dotenv 模板。
 * 4. regularFile 检查类型和大小，workspacePath 确认用户选择的工作区确实是一个目录。
 *
 * 符号链接和待创建文件不能只靠字符串前缀检查。这里返回路径信息，是否批准访问由调用方决定。
 */

import { realpath, lstat, stat } from "node:fs/promises";
import path from "node:path";

export function inside(root: string, target: string) {
  const rel = path.relative(root, target);

  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}

export async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const parent = path.dirname(target);

    if (parent === target) {
      throw error;
    }

    return path.join(await canonical(parent), path.basename(target));
  }
}

export type PathRisk =
  "hard-sensitive" | "dotenv-runtime" | "dotenv-template" | "ordinary";

function dotenvTemplateName(name: string) {
  return /^(?:\.env|[A-Za-z0-9][A-Za-z0-9._-]*\.env)\.(?:example|sample|template|dist)$/i.test(
    name,
  );
}

function dotenvRuntimeName(name: string) {
  return /^\.env(?:\.|$)/i.test(name);
}

function hardSensitiveName(name: string) {
  return /^\.ssh$|^\.aws$|^\.npmrc$|^\.git$|^credentials$|^id_(rsa|ed25519)$|\.pem$|\.key$/i.test(
    name,
  );
}

/** Git 对模板另行验证内容；普通文件访问仍将所有 dotenv 变体视为需要确认的敏感路径。 */
export function pathRisk(target: string): PathRisk {
  let template = false;

  for (const part of target.split(/[\\/]/)) {
    if (hardSensitiveName(part)) {
      return "hard-sensitive";
    }

    if (dotenvRuntimeName(part) && !dotenvTemplateName(part)) {
      return "dotenv-runtime";
    }

    if (dotenvTemplateName(part)) {
      template = true;
    }
  }

  return template ? "dotenv-template" : "ordinary";
}

export function sensitive(target: string) {
  return target.split(/[\\/]/).some((part) => {
    return hardSensitiveName(part) || dotenvRuntimeName(part);
  });
}

export async function resolveTarget(root: string, input: string) {
  if (input.includes("\0")) {
    throw new Error("路径包含非法字符");
  }

  if (
    process.platform === "win32" &&
    input.replace(/^[a-z]:/i, "").includes(":")
  ) {
    throw new Error("不支持 NTFS 备用数据流路径");
  }

  const lexical = path.resolve(root, input);
  const resolved = await canonical(lexical);

  return {
    path: resolved,
    outside: !inside(root, resolved),
    sensitive: sensitive(lexical) || sensitive(resolved),
  };
}

export async function regularFile(file: string, maxBytes: number) {
  const info = await lstat(file);

  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("仅支持普通文件");
  }

  if (info.size > maxBytes) {
    throw new Error("文件过大，请缩小读取范围或使用搜索。");
  }

  return info;
}

export async function workspacePath(input: string) {
  const root = await realpath(path.resolve(input));

  if (!(await stat(root)).isDirectory()) {
    throw new Error("工作区必须是目录");
  }

  return root;
}
