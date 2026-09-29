/**
 * 为 Store 与 Store Worker 提供相同的 replay 增量 SQLite 编码。
 * 输入是任务 ID、一次模型/工具开始或结束及已脱敏的材料；输出是在导出时重建的完整 TaskReplayCapture。
 *
 * 1. 新任务只在 task_replays 保存元数据，逐个模型/工具写入 replay_entries。
 * 2. 模型 input 记录相对上一请求的相同前缀与新增尾部；每次写入只影响当前条目。
 * 3. 读取时依写入顺序重建完整请求，旧任务的整条 JSON 原样读取，不在迁移时改写敏感材料。
 *
 * 调用方负责 SQLite 事务及凭据脱敏；本模块不执行工具、模型或网络请求。
 */

import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type {
  RecordedModelExchange,
  RecordedToolCall,
  TaskReplayCapture,
} from "./replay-case.js";
import type { TaskStatus } from "../shared/types.js";

type ReplayAction =
  | "create"
  | "modelStart"
  | "modelFinish"
  | "toolStart"
  | "toolFinish"
  | "finish";

type StoredHeader = Omit<TaskReplayCapture, "modelExchanges" | "tools"> & {
  storageVersion: 2;
};

type StoredModel = Omit<RecordedModelExchange, "input"> & {
  inputPrefix: number;
  inputSuffix: any[];
};

type EntryRow = { kind: "model" | "tool"; data: string };

function header(db: DatabaseSync, taskId: string) {
  const row = db
    .prepare("SELECT data FROM task_replays WHERE taskId=?")
    .get(taskId) as { data: string } | undefined;

  return row
    ? (JSON.parse(row.data) as StoredHeader | TaskReplayCapture)
    : undefined;
}

function decodeModel(
  stored: StoredModel,
  previous: any[],
): RecordedModelExchange {
  const { inputPrefix, inputSuffix, ...exchange } = stored;
  if (
    !Number.isInteger(inputPrefix) ||
    inputPrefix < 0 ||
    inputPrefix > previous.length ||
    !Array.isArray(inputSuffix)
  ) {
    throw new Error("Replay 模型输入增量已损坏。");
  }

  return {
    ...exchange,
    input: [...previous.slice(0, inputPrefix), ...inputSuffix],
  };
}

function entries(db: DatabaseSync, taskId: string): EntryRow[] {
  return db
    .prepare("SELECT kind,data FROM replay_entries WHERE taskId=? ORDER BY seq")
    .all(taskId) as EntryRow[];
}

/** 只重建导出时需要的完整结构；历史整条捕获保持向后兼容。 */
export function readReplayCapture(db: DatabaseSync, taskId: string) {
  const stored = header(db, taskId);
  if (!stored) {
    return undefined;
  }

  if (!("storageVersion" in stored)) {
    return stored as TaskReplayCapture;
  }

  const { storageVersion, ...metadata } = stored;
  if (storageVersion !== 2) {
    throw new Error("不支持的 Replay 存储版本。");
  }

  const capture: TaskReplayCapture = {
    ...metadata,
    modelExchanges: [],
    tools: [],
  };
  let previous: any[] = [];
  for (const row of entries(db, taskId)) {
    if (row.kind === "model") {
      const exchange = decodeModel(
        JSON.parse(row.data) as StoredModel,
        previous,
      );
      capture.modelExchanges.push(exchange);
      previous = exchange.input;
    } else {
      capture.tools.push(JSON.parse(row.data) as RecordedToolCall);
    }
  }

  return capture;
}

/** 上一请求可从持久化增量恢复，不依赖进程内缓存或 Worker 存活。 */
function lastInput(db: DatabaseSync, taskId: string) {
  let previous: any[] = [];
  const rows = db
    .prepare(
      "SELECT data FROM replay_entries WHERE taskId=? AND kind='model' ORDER BY seq",
    )
    .all(taskId) as Array<{ data: string }>;
  for (const row of rows) {
    previous = decodeModel(JSON.parse(row.data) as StoredModel, previous).input;
  }

  return previous;
}

export function writeReplay(
  db: DatabaseSync,
  taskId: string,
  action: ReplayAction,
  key: string | null,
  data: unknown,
) {
  if (action === "create") {
    db.prepare("INSERT INTO task_replays(taskId,data) VALUES(?,?)").run(
      taskId,
      JSON.stringify({ ...(data as object), storageVersion: 2 }),
    );

    return;
  }

  const stored = header(db, taskId);
  if (!stored || !("storageVersion" in stored) || stored.storageVersion !== 2) {
    throw new Error("Replay 增量捕获不存在或格式不正确。");
  }

  if (action === "finish") {
    db.prepare("UPDATE task_replays SET data=? WHERE taskId=?").run(
      JSON.stringify({
        ...stored,
        status: data as TaskStatus,
        finalizedAt: new Date().toISOString(),
      }),
      taskId,
    );

    return;
  }

  if (action === "modelStart") {
    const exchange = data as RecordedModelExchange;
    const previous = lastInput(db, taskId);
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < exchange.input.length &&
      isDeepStrictEqual(previous[prefix], exchange.input[prefix])
    ) {
      prefix++;
    }

    const { input, ...rest } = exchange;
    db.prepare(
      "INSERT INTO replay_entries(taskId,kind,itemId,data) VALUES(?,'model',?,?)",
    ).run(
      taskId,
      exchange.id,
      JSON.stringify({
        ...rest,
        inputPrefix: prefix,
        inputSuffix: input.slice(prefix),
      } satisfies StoredModel),
    );

    return;
  }

  if (action === "toolStart") {
    const tool = data as RecordedToolCall;
    db.prepare(
      "INSERT INTO replay_entries(taskId,kind,itemId,data) VALUES(?,'tool',?,?)",
    ).run(taskId, tool.callId, JSON.stringify(tool));

    return;
  }

  const kind = action === "modelFinish" ? "model" : "tool";
  const row = db
    .prepare(
      "SELECT data FROM replay_entries WHERE taskId=? AND kind=? AND itemId=?",
    )
    .get(taskId, kind, key) as { data: string } | undefined;
  if (!row) {
    // 宿主工具反馈也可在没有 replay toolStart 的兼容路径提交；旧整条捕获同样忽略该终态。
    if (kind === "tool") {
      return;
    }

    throw new Error("Replay 捕获终态缺少对应的开始记录。");
  }

  const entry = JSON.parse(row.data) as StoredModel | RecordedToolCall;
  const updated =
    kind === "model"
      ? { ...entry, ...(data as object) }
      : { ...entry, result: data };
  db.prepare(
    "UPDATE replay_entries SET data=? WHERE taskId=? AND kind=? AND itemId=?",
  ).run(JSON.stringify(updated), taskId, kind, key);
}
