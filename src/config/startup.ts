/**
 * 产品启动与手动探针共用的无 dotenv 配置入口，数据位置是唯一启动参数。
 * 1. startupDirectory 解析 --data-dir，否则使用平台目录，不采用旧 CODEATELIER_DATA_DIR。
 * 2. startupConfig 禁止将旧无版本文件当作新安装；迁移必须经单独显式入口。
 * 不启动 HTTP、不迁移历史、不读取或删除 .env；系统 PATH/HOME 等仍正常保留。
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { dataDirectory } from "./data-directory.js";
import { Config } from "./config.js";

export function startupDirectory(args = process.argv.slice(2)): string {
  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options: { "data-dir": { type: "string" } },
    strict: true,
  });

  return values["data-dir"]
    ? path.resolve(values["data-dir"])
    : dataDirectory(false);
}

export function startupConfig(args = process.argv.slice(2)) {
  return new Config(startupDirectory(args), { legacy: false });
}
