/**
 * 手动从本机 SQLite 历史导出单个任务的 replay case。
 * 开发者通过 package.json 的 replay:export 入口提供数据目录、任务 ID 和全新输出文件；本脚本只读取
 * Store，不启动 HTTP 服务、模型请求、工具执行或 Evaluation。输出由 sessions/replay-case.ts 以 0600
 * 权限创建，可能包含本地 prompt、源码和工具材料，调用者必须自行保护该文件。
 *
 * 1. parseArgs 校验三个显式参数，拒绝缺失值和不存在的历史数据库。
 * 2. 以 interruptActive:false 打开 Store，确保只读导出不会把仍在运行的任务错误标记为 interrupted。
 * 3. Store 重建 captured 或 legacy case；writeReplayCase 仅创建新文件，成功才输出简短的安全提示。
 *
 * 此入口不把旧历史伪装成完整 transcript；legacy case 只能根据其保存的 read_file 结果尝试隔离文件重建。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { dataDirectory } from "../config/data-directory.js";
import { Store } from "../sessions/store.js";
import { writeReplayCase } from "../sessions/replay-case.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "task-id": { type: "string" },
    output: { type: "string" },
  },
});

if (!values["task-id"] || !values.output) {
  throw new Error(
    "Required: --task-id TASK_ID --output NEW_CASE.json [--data-dir PATH]",
  );
}

const directory = path.resolve(values["data-dir"] || dataDirectory());
const database = path.join(directory, "history.sqlite");
if (!existsSync(database)) {
  throw new Error(
    "CodeAtelier history.sqlite does not exist in the selected data directory.",
  );
}

const store = new Store(database, { interruptActive: false });
try {
  const caseFile = store.replayCase(values["task-id"]);
  if (!caseFile) {
    throw new Error("Task does not exist in the selected history database.");
  }

  await writeReplayCase(path.resolve(values.output), caseFile);
  process.stdout.write(
    `Replay case exported (${caseFile.source}); protect the local output file.\n`,
  );
} finally {
  store.close();
}
