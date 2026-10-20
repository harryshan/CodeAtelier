/**
 * 为 Windows/MXC 启动准备生成实例专用的 Git global 配置，不执行 Git 或读取宿主配置。
 * 1. metadata 只将缺失路径视为非仓库；权限/I/O 错误交由启动器的失败与清理路径处理。
 * 2. workspaceGitConfig 检测工作目录自身的 .git（目录或 worktree gitfile），以及裸库布局。
 * 3. 只写规范化真实工作目录的 safe.directory，不信任父目录或通配符；quoteGitConfigValue 同时供身份序列化转义配置字符串。
 * 返回配置文本，由调用方独占写入逐实例文件并随实例清理；无共享配置写入或新增文件访问授权。
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

async function metadata(file: string) {
  try {
    return await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function workspaceGitConfig(workspace: string): Promise<string> {
  const root = await realpath(workspace);
  const git = await metadata(path.join(root, ".git"));
  let repository = git?.isDirectory() || git?.isFile();
  if (!repository) {
    const head = await metadata(path.join(root, "HEAD"));
    const objects = await metadata(path.join(root, "objects"));
    const config = await metadata(path.join(root, "config"));
    repository = head?.isFile() && objects?.isDirectory() && config?.isFile();
  }

  if (!repository) {
    return "";
  }

  let directory =
    process.platform === "win32" ? root.replaceAll("\\", "/") : root;
  // Git 将结尾 /* 解释为信任子树；字面星号目录加 /. 仍指向同一目录，而不是扩大信任。
  if (directory.endsWith("/*")) {
    directory += "/.";
  }

  return `[safe]\n\tdirectory = ${quoteGitConfigValue(directory)}\n`;
}

export function quoteGitConfigValue(value: string) {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\b", "\\b");

  return `"${escaped}"`;
}
