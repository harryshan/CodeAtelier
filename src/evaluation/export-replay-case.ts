/**
 * 手动从本机 SQLite 历史导出单个任务的 replay case。
 * 开发者通过 package.json 的 replay:export 入口提供数据目录、任务 ID 和全新输出文件；本脚本只读取
 * Store，不启动 HTTP 服务、模型请求、工具执行或 Evaluation。输出由 sessions/replay-case.ts 以 0600
 * 权限创建，可能包含本地 prompt、源码和工具材料，调用者必须自行保护该文件。
 *
 * 1. parseArgs 支持列出任务 ID，或校验显式导出参数并拒绝缺失值和不存在的历史数据库。
 * 2. 解析活动 generation，再以 readOnly:true、inline:true 打开 Store，不初始化 schema、不变更任务或启动写 Worker。
 * 3. 列表仅显示任务 ID、状态和时间；导出时 Store 重建 captured 或 legacy case，writeReplayCase 仅创建新文件。
 *
 * 此入口不把旧历史伪装成完整 transcript；legacy case 只能根据其保存的 read_file 结果尝试隔离文件重建。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { dataDirectory } from "../config/data-directory.js";
import { Store } from "../sessions/store.js";
import { resolveHistoryFile } from "../sessions/history-generation.js";
import { writeReplayCase } from "../sessions/replay-case.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "task-id": { type: "string" },
    output: { type: "string" },
    list: { type: "boolean" },
  },
});

if (!values.list && (!values["task-id"] || !values.output)) {
  throw new Error(
    "Required: --list [--data-dir PATH], or --task-id TASK_ID --output NEW_CASE.json [--data-dir PATH]",
  );
}

const directory = path.resolve(values["data-dir"] || dataDirectory());
const database = resolveHistoryFile(path.join(directory, "history.sqlite"));
if (!existsSync(database)) {
  throw new Error(
    "CodeAtelier history.sqlite does not exist in the selected data directory.",
  );
}

const store = new Store(database, { readOnly: true, inline: true });
try {
  if (values.list) {
    const tasks = store.list().flatMap((session) =>
      store.tasks(session.id).map((task) => ({
        id: task.id,
        status: task.status,
        createdAt: task.createdAt,
      })),
    );
    process.stdout.write(
      tasks
        .map((task) => `${task.id}\t${task.status}\t${task.createdAt}`)
        .join("\n") + (tasks.length ? "\n" : ""),
    );
  } else {
    const caseFile = store.replayCase(values["task-id"]!);
    if (!caseFile) {
      throw new Error("Task does not exist in the selected history database.");
    }

    await writeReplayCase(path.resolve(values.output!), caseFile);
    process.stdout.write(
      `Replay case exported (${caseFile.source}); protect the local output file.\n`,
    );
  }
} finally {
  await store.closeAsync();
}
