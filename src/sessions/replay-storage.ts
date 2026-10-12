/**
 * 保存目标 v3 Replay，供 Store 后端、离线转换器和请求阅读接口共用。
 * 输入为脱敏的请求/工具材料及终态；输出为单个请求或完整导出捕获，不执行模型和工具。
 *
 * 1. 元数据只接受 v3；旧格式解码属于离线迁移，运行期不能回读原库。
 * 2. 请求使用精确序列化前缀与尾部，每 32 条或累计 16 MiB 增量创建检查点。
 * 3. 单请求从最近检查点重建；写入也只读取有界尾链，不扫描任务全部模型历史。
 * 4. 响应、错误和工具结果存入独立 outcome 列；结束操作不重写不可变请求。
 * 5. 不保存未提交缓存；调用方负责同分片事务，回滚后没有可推进的内存前缀。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  RecordedModelExchange,
  RecordedToolCall,
  TaskReplayCapture,
} from "./replay-case.js";
import type { TaskStatus } from "../shared/types.js";

export const REPLAY_STORAGE_VERSION = 3;
export const REPLAY_CHECKPOINT_INTERVAL = 32;
export const REPLAY_DELTA_BYTES = 16 * 1024 * 1024;

export type ReplayAction =
  | "create"
  | "modelStart"
  | "modelFinish"
  | "toolStart"
  | "toolFinish"
  | "finish";
type StoredHeader = Omit<TaskReplayCapture, "modelExchanges" | "tools"> & {
  storageVersion: 3;
};
type StoredModel = Omit<RecordedModelExchange, "input"> & {
  inputPrefix: number;
  inputSuffix: any[];
};
interface EntryRow {
  seq: number;
  kind: "model" | "tool";
  itemId: string;
  data: string;
  outcome: string | null;
  checkpoint: number;
  byteSize: number;
}

function header(db: DatabaseSync, taskId: string): StoredHeader | undefined {
  const row = db
    .prepare("SELECT data FROM task_replays WHERE taskId=?")
    .get(taskId);
  if (!row) {
    return undefined;
  }

  const value = JSON.parse(String(row.data)) as StoredHeader;
  if (value.storageVersion !== REPLAY_STORAGE_VERSION) {
    throw new Error("Replay 尚未完成离线迁移，拒绝读取旧格式。");
  }

  return value;
}

function decode(row: EntryRow, previous: any[]): RecordedModelExchange {
  const { inputPrefix, inputSuffix, ...exchange } = JSON.parse(
    row.data,
  ) as StoredModel;
  if (
    !Number.isSafeInteger(inputPrefix) ||
    inputPrefix < 0 ||
    inputPrefix > previous.length ||
    !Array.isArray(inputSuffix) ||
    (row.checkpoint === 1 && inputPrefix !== 0)
  ) {
    throw new Error("Replay 模型输入增量已损坏。");
  }

  return {
    ...exchange,
    input: [...previous.slice(0, inputPrefix), ...inputSuffix],
    ...(row.outcome === null ? {} : JSON.parse(row.outcome)),
  };
}

/** 返回完整候选链，检查点之前的请求不参与随机读取。 */
function modelChain(db: DatabaseSync, taskId: string, seq: number): EntryRow[] {
  const checkpoint = db
    .prepare(
      "SELECT seq FROM replay_entries WHERE taskId=? AND kind='model' AND checkpoint=1 AND seq<=? ORDER BY seq DESC LIMIT 1",
    )
    .get(taskId, seq);
  if (!checkpoint) {
    throw new Error("Replay 请求缺少检查点。");
  }

  const rows = db
    .prepare(
      "SELECT * FROM replay_entries WHERE taskId=? AND kind='model' AND seq BETWEEN ? AND ? ORDER BY seq",
    )
    .all(taskId, checkpoint.seq!, seq) as unknown as EntryRow[];
  if (rows.length > REPLAY_CHECKPOINT_INTERVAL) {
    throw new Error("Replay 增量链超过格式上限。");
  }

  return rows;
}

export function readReplayExchange(
  db: DatabaseSync,
  taskId: string,
  itemId: string,
) {
  const row = db
    .prepare(
      "SELECT seq FROM replay_entries WHERE taskId=? AND kind='model' AND itemId=?",
    )
    .get(taskId, itemId);
  if (!row) {
    return undefined;
  }

  let exchange: RecordedModelExchange | undefined;
  for (const entry of modelChain(db, taskId, Number(row.seq))) {
    exchange = decode(entry, exchange?.input ?? []);
  }

  return exchange;
}

export function readReplayCapture(
  db: DatabaseSync,
  taskId: string,
): TaskReplayCapture | undefined {
  const stored = header(db, taskId);
  if (!stored) {
    return undefined;
  }

  const metadata = { ...stored };
  Reflect.deleteProperty(metadata, "storageVersion");
  const capture: TaskReplayCapture = {
    ...metadata,
    modelExchanges: [],
    tools: [],
  };
  let previous: any[] = [];
  for (const row of db
    .prepare("SELECT * FROM replay_entries WHERE taskId=? ORDER BY seq")
    .iterate(taskId) as IterableIterator<unknown>) {
    const entry = row as EntryRow;
    if (entry.kind === "model") {
      const exchange = decode(entry, previous);
      capture.modelExchanges.push(exchange);
      previous = exchange.input;
    } else {
      capture.tools.push({
        ...JSON.parse(entry.data),
        ...(entry.outcome === null ? {} : JSON.parse(entry.outcome)),
      });
    }
  }

  return capture;
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
      JSON.stringify({
        ...(data as object),
        storageVersion: REPLAY_STORAGE_VERSION,
      }),
    );

    return;
  }

  const stored = header(db, taskId);
  if (!stored) {
    throw new Error("Replay 捕获不存在。");
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
    const last = db
      .prepare(
        "SELECT seq FROM replay_entries WHERE taskId=? AND kind='model' ORDER BY seq DESC LIMIT 1",
      )
      .get(taskId);
    const chain = last ? modelChain(db, taskId, Number(last.seq)) : [];
    let previous: any[] = [];
    for (const row of chain) {
      previous = decode(row, previous).input;
    }

    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < exchange.input.length &&
      JSON.stringify(previous[prefix]) ===
        JSON.stringify(exchange.input[prefix])
    ) {
      prefix++;
    }

    const { input, response, error, ...rest } = exchange;
    let payload = JSON.stringify({
      ...rest,
      inputPrefix: prefix,
      inputSuffix: input.slice(prefix),
    });
    const checkpoint =
      chain.length === 0 ||
      chain.length >= REPLAY_CHECKPOINT_INTERVAL ||
      chain.slice(1).reduce((sum, row) => sum + row.byteSize, 0) +
        Buffer.byteLength(payload) >
        REPLAY_DELTA_BYTES;
    if (checkpoint) {
      payload = JSON.stringify({ ...rest, inputPrefix: 0, inputSuffix: input });
    }

    const outcome =
      response !== undefined || error !== undefined
        ? JSON.stringify({
            ...(response === undefined ? {} : { response }),
            ...(error === undefined ? {} : { error }),
          })
        : null;
    db.prepare(
      "INSERT INTO replay_entries(taskId,kind,itemId,data,outcome,checkpoint) VALUES(?,'model',?,?,?,?)",
    ).run(taskId, exchange.id, payload, outcome, Number(checkpoint));

    return;
  }

  if (action === "toolStart") {
    const { result, ...tool } = data as RecordedToolCall;
    db.prepare(
      "INSERT INTO replay_entries(taskId,kind,itemId,data,outcome) VALUES(?,'tool',?,?,?)",
    ).run(
      taskId,
      tool.callId,
      JSON.stringify(tool),
      result === undefined ? null : JSON.stringify({ result }),
    );

    return;
  }

  const kind = action === "modelFinish" ? "model" : "tool";
  const row = db
    .prepare(
      "SELECT outcome FROM replay_entries WHERE taskId=? AND kind=? AND itemId=?",
    )
    .get(taskId, kind, key);
  if (!row) {
    if (kind === "tool") {
      return;
    }

    throw new Error("Replay 捕获终态缺少对应的开始记录。");
  }

  const outcome =
    kind === "model"
      ? {
          ...(row.outcome === null ? {} : JSON.parse(String(row.outcome))),
          ...(data as object),
        }
      : { result: data };
  db.prepare(
    "UPDATE replay_entries SET outcome=? WHERE taskId=? AND kind=? AND itemId=?",
  ).run(JSON.stringify(outcome), taskId, kind, key);
}
