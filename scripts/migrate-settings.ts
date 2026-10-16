/**
 * 手动迁移 CLI：默认只预检，--write-candidate 写独立私有候选，--apply-candidate 显式切换。
 * 1. 严格解析旧数据目录与 dotenv/候选路径，拒绝组合不明确的写入模式。
 * 2. 调用迁移服务，只记录来源字段名和候选/目标路径，不记录配置值。
 * 3. 失败使用固定安全错误与退出码；不启动模型、数据库、服务或 Evaluation。
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { createLogger } from "../src/logging/logger.js";
import {
  createSettingsCandidate,
  activateSettingsCandidate,
} from "../src/config/migrate-settings.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "env-file": { type: "string" },
    "write-candidate": { type: "boolean" },
    "apply-candidate": { type: "string" },
    "confirm-stopped": { type: "boolean" },
  },
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  strict: true,
});
if (
  !values["data-dir"] ||
  !!values["env-file"] === !!values["apply-candidate"] ||
  (values["apply-candidate"] && values["write-candidate"])
) {
  throw new Error(
    "用法：--data-dir <旧数据目录> --env-file <旧dotenv> [--write-candidate]；或 --data-dir <目录> --apply-candidate <候选> --confirm-stopped",
  );
}

const directory = path.resolve(values["data-dir"]);
const log = createLogger(directory, "info");
try {
  const result = values["apply-candidate"]
    ? await activateSettingsCandidate(
        directory,
        path.resolve(values["apply-candidate"]),
        !!values["confirm-stopped"],
      )
    : await createSettingsCandidate(
        directory,
        path.resolve(values["env-file"]!),
        !!values["write-candidate"],
      );
  log.info({
    event: "settings.migration_completed",
    module: "settings",
    ...result,
  });
} catch (error) {
  log.error({
    event: "settings.migration_failed",
    module: "settings",
    reason: error instanceof Error ? error.message : "迁移失败",
  });
  process.exitCode = 1;
}
