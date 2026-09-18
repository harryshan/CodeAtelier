/**
 * 用 SQLite 保存会话、任务、事件和模型上下文，供 Engine、HTTP 接口和 ContextManager 使用。
 *
 * 1. 构造器初始化数据库，把重启前未完成的任务标为 interrupted 并记录结束时间；transaction 包装提交和回滚。
 * 2. list/get/create 读写会话；标题状态的领取、完成或失败保证首条 prompt 只生成一次标题。
 * 3. tasks/task/createTask/status 读写任务状态；queuedTasks 和 hasUnfinishedTask 供 Engine 调度跨会话队列，event/events 保存和分页读取事件。
 * 4. task_replays 在任务开始后追加高保真模型/工具材料；replayCase 导出单任务的 captured 或 legacy case，不触发恢复或副作用。
 * 5. context/saveContext 读写当前模型历史；较大的 context、events 和快照可交给 store-worker 在线程外解析或原子写入，避免阻塞 HTTP 主线程。
 * 6. close 由应用退出流程调用，关闭数据库连接；Worker 自己打开短生命周期的 WAL 连接，不持有 Store 的连接。
 *
 * 事务只能回滚数据库，不能撤销文件修改或命令执行。恢复需要的未知状态和原始记录必须保留。
 */

import type { ContextSnapshot } from "../context/types.js";
import type {
  RecordedModelExchange,
  RecordedToolCall,
  TaskReplayCapture,
  TaskReplayCase,
} from "./replay-case.js";
import { SCHEMA_SQL } from "./schema.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Session, Task, TaskStatus, Event } from "../shared/types.js";

export class Store {
  db: DatabaseSync;

  constructor(
    private file: string,
    options: { interruptActive?: boolean } = {},
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    // 导出历史必须保持只读；正常服务启动仍将无法确认结果的任务标为 interrupted。
    if (options.interruptActive ?? true) {
      this.db
        .prepare(
          "UPDATE tasks SET status='interrupted',error='服务已重启，任务中断；未重放命令。',finishedAt=COALESCE(finishedAt,?) WHERE status IN ('queued','running','waiting')",
        )
        .run(new Date().toISOString());
    }
  }

  /** 将历史会话标为完成，避免升级后用旧消息意外覆盖用户原有标题。 */
  private migrate() {
    const columns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;

    if (!columns.some((column) => column.name === "titleState")) {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN titleState TEXT NOT NULL DEFAULT 'completed'",
      );
    }

    const taskColumns = this.db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "startedAt")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN startedAt TEXT");
    }

    if (!taskColumns.some((column) => column.name === "finishedAt")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN finishedAt TEXT");
    }
  }

  /** 回调必须同步完成，不能在事务中等待网络或其他异步操作。 */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();

      this.db.exec("COMMIT");

      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list() {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY updatedAt DESC")
      .all() as unknown as Session[];
  }

  get(id: string) {
    return this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as unknown as Session | undefined;
  }

  /** 未提供标题的新会话等待其首条 prompt；显式标题只供内部固定用途，不会被模型覆盖。 */
  create(workspace: string, title?: string) {
    const date = new Date().toISOString();
    const id = randomUUID();
    const manualTitle = title?.trim();
    const titleState = manualTitle ? "manual" : "pending";

    this.db
      .prepare(
        "INSERT INTO sessions(id,title,workspace,createdAt,updatedAt,titleState) VALUES(?,?,?,?,?,?)",
      )
      .run(id, manualTitle || "新对话", workspace, date, date, titleState);

    return this.get(id)!;
  }

  /** 以条件更新领取标题任务，避免重试、恢复或并发调用使用后续 prompt 覆盖首条消息。 */
  startTitleGeneration(sessionId: string) {
    const result = this.db
      .prepare(
        "UPDATE sessions SET titleState='generating' WHERE id=? AND titleState='pending'",
      )
      .run(sessionId);

    return result.changes === 1;
  }

  /** 标题成功后与更新时间一起持久化，供会话列表和当前快照刷新。 */
  completeTitleGeneration(sessionId: string, title: string) {
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(
        "UPDATE sessions SET title=?,titleState='completed',updatedAt=? WHERE id=? AND titleState='generating'",
      )
      .run(title, updatedAt, sessionId);

    return this.get(sessionId)!;
  }

  /** 辅助模型失败不影响编码任务，但标记终态以避免自动重试时使用后续 prompt。 */
  failTitleGeneration(sessionId: string) {
    this.db
      .prepare(
        "UPDATE sessions SET titleState='failed' WHERE id=? AND titleState='generating'",
      )
      .run(sessionId);
  }

  tasks(sessionId: string) {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE sessionId=? ORDER BY createdAt, rowid",
      )
      .all(sessionId) as unknown as Task[];
  }

  /** 首条消息判断只需要存在性，不能为此把长工具输出逐条 JSON.parse 到主线程。 */
  hasEvent(sessionId: string, type: string) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM events WHERE sessionId=? AND type=? LIMIT 1")
        .get(sessionId, type),
    );
  }

  /** 恢复只读取目标任务的一条已知事件；大历史继续通过 eventsAsync 在线程外读取。 */
  taskEvent(taskId: string, type: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM events WHERE taskId=? AND type=? ORDER BY id LIMIT 1",
      )
      .get(taskId, type) as { data: string } | undefined;

    return row ? JSON.parse(row.data) : undefined;
  }

  task(id: string) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(id) as unknown as Task | undefined;
  }

  /** replay 导出只读取单个任务的事件，避免将同会话其他任务的历史混入 case。 */
  taskEvents(taskId: string) {
    return this.db
      .prepare("SELECT * FROM events WHERE taskId=? ORDER BY id")
      .all(taskId)
      .map((row) => ({
        ...row,
        data: JSON.parse(String(row.data)),
      })) as Event[];
  }

  /** 任务开始即创建捕获容器；模型请求先写入，进程中断时保留无终态事实而非猜测。 */
  startReplayCapture(
    task: Task,
    capture: Omit<TaskReplayCapture, "modelExchanges" | "tools">,
  ) {
    const data: TaskReplayCapture = {
      ...capture,
      modelExchanges: [],
      tools: [],
    };
    this.db
      .prepare("INSERT INTO task_replays(taskId,data) VALUES(?,?)")
      .run(task.id, JSON.stringify(data));
  }

  private replayCapture(taskId: string) {
    const row = this.db
      .prepare("SELECT data FROM task_replays WHERE taskId=?")
      .get(taskId) as { data: string } | undefined;

    return row ? (JSON.parse(row.data) as TaskReplayCapture) : undefined;
  }

  private saveReplayCapture(taskId: string, capture: TaskReplayCapture) {
    this.db
      .prepare("UPDATE task_replays SET data=? WHERE taskId=?")
      .run(JSON.stringify(capture), taskId);
  }

  startReplayModelExchange(taskId: string, exchange: RecordedModelExchange) {
    const capture = this.replayCapture(taskId);
    if (!capture) {
      return;
    }

    capture.modelExchanges.push(exchange);
    this.saveReplayCapture(taskId, capture);
  }

  finishReplayModelExchange(
    taskId: string,
    id: string,
    outcome: Pick<RecordedModelExchange, "response" | "error">,
  ) {
    const capture = this.replayCapture(taskId);
    const exchange = capture?.modelExchanges.find((item) => item.id === id);
    if (!capture || !exchange) {
      return;
    }

    Object.assign(exchange, outcome);
    this.saveReplayCapture(taskId, capture);
  }

  startReplayTool(taskId: string, tool: RecordedToolCall) {
    const capture = this.replayCapture(taskId);
    if (!capture) {
      return;
    }

    capture.tools.push(tool);
    this.saveReplayCapture(taskId, capture);
  }

  finishReplayTool(taskId: string, callId: string, result: unknown) {
    const capture = this.replayCapture(taskId);
    const tool = capture?.tools.find((item) => item.callId === callId);
    if (!capture || !tool) {
      return;
    }

    tool.result = result;
    this.saveReplayCapture(taskId, capture);
  }

  finishReplayCapture(taskId: string, status: TaskStatus) {
    const capture = this.replayCapture(taskId);
    if (!capture) {
      return;
    }

    capture.status = status;
    capture.finalizedAt = new Date().toISOString();
    this.saveReplayCapture(taskId, capture);
  }

  /** 新捕获优先使用未截断工具材料；旧历史退回事件配对，但 source 必须明确标为 legacy。 */
  replayCase(taskId: string): TaskReplayCase | undefined {
    const task = this.task(taskId);
    if (!task) {
      return undefined;
    }

    const session = this.get(task.sessionId);
    if (!session) {
      return undefined;
    }

    const events = this.taskEvents(taskId);
    const capture = this.replayCapture(taskId);
    const starts = new Map<string, any>();
    for (const event of events) {
      if (
        event.type === "tool_start" &&
        typeof event.data?.callId === "string"
      ) {
        starts.set(event.data.callId, event.data);
      }
    }

    const tools: RecordedToolCall[] = capture?.tools ?? [];
    if (!capture) {
      for (const start of starts.values()) {
        tools.push({
          callId: start.callId,
          nodeId: start.nodeId || start.callId,
          name: start.name,
          arguments: start.args,
          dependsOn: Array.isArray(start.dependsOn) ? start.dependsOn : [],
          batchId: start.batchId || "legacy",
        });
      }

      for (const event of events) {
        if (
          event.type !== "tool_result" ||
          typeof event.data?.callId !== "string"
        ) {
          continue;
        }

        const tool = tools.find((item) => item.callId === event.data.callId);
        if (tool) {
          tool.result = event.data.result;
        }
      }
    }

    return {
      schemaVersion: 1,
      source: capture ? "captured" : "legacy",
      session,
      task,
      capture,
      tools,
      events,
    };
  }

  /** 同一会话的上下文不能并发追加；不同会话的任务由 Engine 依据工作区和全局上限调度。 */
  hasUnfinishedTask(sessionId: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM tasks WHERE sessionId=? AND status IN ('queued','running','waiting') LIMIT 1",
        )
        .get(sessionId),
    );
  }

  /** 排队顺序按创建时间稳定；Engine 可跳过被相同工作区锁阻塞的项，避免空闲并发槽位闲置。 */
  queuedTasks() {
    return this.db
      .prepare(
        "SELECT tasks.*,sessions.workspace FROM tasks JOIN sessions ON sessions.id=tasks.sessionId WHERE tasks.status='queued' ORDER BY tasks.createdAt,tasks.rowid",
      )
      .all() as unknown as Array<Task & { workspace: string }>;
  }

  createTask(sessionId: string) {
    const task = {
      id: randomUUID(),
      sessionId,
      status: "queued" as TaskStatus,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        "INSERT INTO tasks(id,sessionId,status,createdAt) VALUES(?,?,?,?)",
      )
      .run(task.id, sessionId, task.status, task.createdAt);

    return task;
  }

  /** 首次进入 running 时记实际开始时间；排队等待不计入运行统计，终态只在真正结束时记录。 */
  status(id: string, status: TaskStatus, error?: string) {
    const finished = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(status);
    const now = new Date().toISOString();
    const finishedAt = finished ? now : null;
    const startedAt = status === "running" ? now : null;

    this.db
      .prepare(
        "UPDATE tasks SET status=?,error=?,startedAt=CASE WHEN ? IS NULL THEN startedAt ELSE COALESCE(startedAt,?) END,finishedAt=COALESCE(?,finishedAt) WHERE id=?",
      )
      .run(status, error || null, startedAt, startedAt, finishedAt, id);
  }

  event(sessionId: string, taskId: string, type: string, data: unknown): Event {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO events(sessionId,taskId,type,data,createdAt) VALUES(?,?,?,?,?)",
      )
      .run(sessionId, taskId, type, JSON.stringify(data), createdAt);

    this.db
      .prepare("UPDATE sessions SET updatedAt=? WHERE id=?")
      .run(createdAt, sessionId);

    return {
      id: Number(result.lastInsertRowid),
      sessionId,
      taskId,
      type,
      data,
      createdAt,
    };
  }

  events(sessionId: string, after = 0) {
    return this.db
      .prepare("SELECT * FROM events WHERE sessionId=? AND id>? ORDER BY id")
      .all(sessionId, after)
      .map((r) => ({ ...r, data: JSON.parse(String(r.data)) })) as Event[];
  }

  /**
   * 为 HTTP 快照和压缩读取事件；after 仅返回游标之后的新增记录，避免流式刷新反复解析整段历史。
   * 小结果直接读取以免 Worker 启动延迟，长 JSON 才在线程外解析。
   */
  async eventsAsync(sessionId: string, after = 0): Promise<Event[]> {
    return this.serializedSize("events", sessionId, undefined, after) <
      64 * 1024
      ? this.events(sessionId, after)
      : this.runWorker<Event[]>({ operation: "events", sessionId, after });
  }

  context(id: string): any[] {
    const row = this.db
      .prepare("SELECT items FROM context WHERE sessionId=?")
      .get(id);

    return row ? JSON.parse(String(row.items)) : [];
  }

  /** 新任务读取活动上下文时在线程外 JSON.parse；空或短上下文直接读取以避免无意义的 Worker 启动。 */
  async contextAsync(id: string): Promise<any[]> {
    return this.serializedSize("context", id) < 64 * 1024
      ? this.context(id)
      : this.runWorker<any[]>({ operation: "context", sessionId: id });
  }

  saveContext(id: string, items: any[]) {
    this.db
      .prepare(
        "INSERT INTO context VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET items=excluded.items",
      )
      .run(id, JSON.stringify(items));
  }

  latestContextSnapshot(sessionId: string): ContextSnapshot | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM context_snapshots WHERE sessionId=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId);

    return row ? JSON.parse(String(row.data)) : undefined;
  }

  contextSnapshot(sessionId: string, id: string): ContextSnapshot | undefined {
    const row = this.db
      .prepare("SELECT data FROM context_snapshots WHERE sessionId=? AND id=?")
      .get(sessionId, id);

    return row ? JSON.parse(String(row.data)) : undefined;
  }

  /** 压缩链路读取父快照时在线程外解析完整原文；不存在或短快照无需启动 Worker。 */
  async latestContextSnapshotAsync(sessionId: string) {
    return this.serializedSize("latestSnapshot", sessionId) < 64 * 1024
      ? this.latestContextSnapshot(sessionId)
      : this.runWorker<ContextSnapshot | undefined>({
          operation: "latestSnapshot",
          sessionId,
        });
  }

  /** 历史回读和连续压缩按会话读取快照；大 source 不在 API 主线程 JSON.parse。 */
  async contextSnapshotAsync(sessionId: string, id: string) {
    return this.serializedSize("snapshot", sessionId, id) < 64 * 1024
      ? this.contextSnapshot(sessionId, id)
      : this.runWorker<ContextSnapshot | undefined>({
          operation: "snapshot",
          sessionId,
          snapshotId: id,
        });
  }

  /** 长度聚合只扫描 SQLite 元数据，不读取 JSON 内容；64 KiB 以下的同步解析有界且避免短请求的线程创建开销。 */
  private serializedSize(
    source: "events" | "context" | "latestSnapshot" | "snapshot",
    sessionId: string,
    snapshotId?: string,
    after = 0,
  ) {
    if (source === "events") {
      const row = this.db
        .prepare(
          "SELECT COALESCE(SUM(length(data)), 0) AS size FROM events WHERE sessionId=? AND id>?",
        )
        .get(sessionId, after) as { size: number };

      return row.size;
    }

    if (source === "context") {
      const row = this.db
        .prepare("SELECT length(items) AS size FROM context WHERE sessionId=?")
        .get(sessionId) as { size: number | null } | undefined;

      return row?.size ?? 0;
    }

    const row = this.db
      .prepare(
        source === "latestSnapshot"
          ? "SELECT length(data) AS size FROM context_snapshots WHERE sessionId=? ORDER BY rowid DESC LIMIT 1"
          : "SELECT length(data) AS size FROM context_snapshots WHERE sessionId=? AND id=?",
      )
      .get(...(snapshotId ? [sessionId, snapshotId] : [sessionId])) as
      { size: number | null } | undefined;

    return row?.size ?? 0;
  }

  /** 快照和活动上下文在线程外序列化并在同一事务提交；主线程不会因大 JSON 或磁盘等待失去 API 响应。 */
  async compactContextAsync(snapshot: ContextSnapshot, input: any[]) {
    await this.runWorker<void>({
      operation: "compact",
      sessionId: snapshot.sessionId,
      snapshot,
      input,
    });
  }

  /** Worker 只接受固定 operation 和本 Store 数据库路径，不能成为通用 SQL 或命令执行入口。 */
  private async runWorker<T>(request: {
    operation: "context" | "events" | "latestSnapshot" | "snapshot" | "compact";
    sessionId: string;
    snapshotId?: string;
    after?: number;
    snapshot?: unknown;
    input?: unknown;
  }): Promise<T> {
    const source = import.meta.url.endsWith(".ts")
      ? new URL("./store-worker.ts", import.meta.url)
      : new URL("./store-worker.js", import.meta.url);
    const worker = new Worker(source, {
      execArgv: source.pathname.endsWith(".ts")
        ? ["--import", "tsx"]
        : undefined,
    });
    worker.unref();

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        void worker.terminate();
      };

      worker.once("error", (error) => {
        cleanup();
        reject(error);
      });
      worker.once(
        "message",
        (message: { ok: boolean; value?: T; error?: string }) => {
          cleanup();
          if (message.ok) {
            resolve(message.value as T);
          } else {
            reject(new Error(message.error || "Store Worker 执行失败。"));
          }
        },
      );
      worker.postMessage({ ...request, file: this.file });
    });
  }

  close() {
    this.db.close();
  }
}
