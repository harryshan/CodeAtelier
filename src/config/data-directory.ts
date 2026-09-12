/**
 * 文件作用：确定本机配置、日志和历史数据的存放目录。
 *
 * 模块协作与输入输出：
 * 供 Config 决定默认数据根目录；配置、日志和 SQLite 历史随后在该目录下各自组织。
 *
 * 代码结构与执行顺序：
 * 1. 显式 CODEATELIER_DATA_DIR 先转为绝对路径并直接返回。
 * 2. Windows 使用 LOCALAPPDATA，macOS 使用 Application Support，Linux 使用 XDG_DATA_HOME 或用户默认路径。
 * 3. 未显式指定时在平台基础目录下追加 CodeAtelier。
 *
 * 关键约束：
 * 这里只计算路径，不创建目录或读写数据；具体文件权限由写入模块负责。
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
