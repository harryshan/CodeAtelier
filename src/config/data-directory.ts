/**
 * 文件作用：确定本机配置、日志和历史数据的存放目录。
 * 代码结构：dataDirectory 优先使用显式环境配置，再按 Windows、macOS 和 Linux 选择平台目录。
 */

import path from "node:path";
import { homedir } from "node:os";

export function dataDirectory() {
  if (process.env.CODEATELIER_DATA_DIR) {
    return path.resolve(process.env.CODEATELIER_DATA_DIR);
  }

  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support")
        : process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");

  return path.join(base, "CodeAtelier");
}
