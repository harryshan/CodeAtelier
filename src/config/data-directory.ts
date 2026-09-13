/**
 * 为 Config 选择配置、日志和 SQLite 历史的存放目录。
 * 读取环境变量和系统信息，返回目录路径；创建目录由后续写入模块负责。
 *
 * 1. 设置了 CODEATELIER_DATA_DIR 时，将它转成绝对路径并返回。
 * 2. 否则按平台选择 LOCALAPPDATA、Application Support 或 XDG_DATA_HOME 等默认位置。
 * 3. 在默认位置下使用 CodeAtelier 子目录。
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
