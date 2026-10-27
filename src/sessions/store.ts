/**
 * Worker 内部 SQLite 实现及同步测试适配器；生产 Engine、HTTP 与 ContextManager 经 AsyncStore 固定 RPC 访问。
 *
 * 1. 构造器发现兼容的 history.sqlite 与后续容量分片，只为新文件初始化目标 schema并把重启前未完成的任务标为 interrupted；transaction 同步提交，取锁或执行失败时释放本次已开启的事务。
 * 2. list/get/create 跨分片定位或聚合会话；新会话在最新分片达到容量上限后进入新文件，已有会话始终写回其初始分片。标题状态的领取、完成或失败保证首条 prompt 只生成一次标题。
 * 3. tasks/task/createTask/status 读写任务状态与不可变的 subagent 选择；旧分片必须离线迁移，SQLite 的 0/1 在各读取入口转换为布尔值。queuedTasks 和 hasUnfinishedTask 供 Engine 调度跨会话队列，event/events 保存和分页读取事件。
 * 4. subagents/subagent_requests 按任务保存完整计划、检查点、报告与回执，不附加子任务文本配额；replay 元数据和逐条模型/工具增量经 replay-storage 写入，只读取已经转换的 v3 捕获；replayCase 从模型材料及子检查点补全阅读用 tools，不重写原始 capture.tools 或历史库。
 * 5. 离线转换器将旧 context 原样迁入 context_chunks 基线；appendContext 只写新增批次，saveContext/压缩替换基线并原子清除会话 token 锚点，读时按顺序重建；大记录由 store-worker 解析。
 * 6. inline 模式在所属 Worker 内完成固定操作；测试适配器可使用独立队列。统计随事件提交，分页延迟正文，Replay 多查询使用同一读事务；closeAsync 排空并释放连接。
 *
 * 事务只能回滚数据库，不能撤销文件修改或命令执行。恢复需要的未知状态和原始记录必须保留。
 */

import {
  tokenAnchorSchema,
  type TokenAnchor,
} from "../context/token-anchor.js";
import type { ContextSnapshot } from "../context/types.js";
import type {
  RecordedModelExchange,
  RecordedToolCall,
  TaskReplayCapture,
  TaskReplayCase,
} from "./replay-case.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TraceRecorder } from "../tracing/recorder.js";
import type {
  Session,
  Task,
  TaskStatus,
  Event,
  SubagentRecord,
  SubagentStatus,
} from "../shared/types.js";
import {
  validateSubagentPlan,
  type SubtaskPlan,
} from "../agent/subagent-contracts.js";
import {
  DEFAULT_HISTORY_SHARD_MAX_BYTES,
  HistoryShards,
} from "./history-shards.js";
import { handle } from "./store-operations.js";
import { WorkerTimings } from "./worker-timing.js";
import { appendStatistics, readStatistics } from "./statistics-projection.js";
import { prepareSessionStatistics } from "../shared/session-statistics.js";
import { completeReplayTools } from "../shared/replay-tool-records.js";
import { StoreWorkerQueue } from "./store-worker-queue.js";
import {
  readReplayCapture,
  readReplayExchange,
  writeReplay,
} from "./replay-storage.js";
import type { StoreWorkerRequest } from "./store-worker.js";

type TaskRow = Omit<Task, "subagentsEnabled"> & {
  subagentsEnabled: number;
  orderKey?: number;
};

export class Store {
  db: DatabaseSync;
  private readonly shards: HistoryShards;
  private nextEventId: number;
  private closing?: Promise<void>;
  private transactionActive = false;
  private transactionDatabase?: DatabaseSync;
  private readonly worker: Pick<
    StoreWorkerQueue,
    "request" | "drain" | "close" | "setTracer"
  >;

  constructor(
    file: string,
    options: {
      interruptActive?: boolean;
      maxShardBytes?: number;
      inline?: boolean;
      readOnly?: boolean;
    } = {},
  ) {
    this.shards = new HistoryShards(
      file,
      options.maxShardBytes ?? DEFAULT_HISTORY_SHARD_MAX_BYTES,
      options.readOnly,
    );
    this.db = this.shards.active().db;
    this.worker = options.inline
      ? {
          request: async <T>(
            request: Omit<StoreWorkerRequest, "id">,
          ): Promise<T> => {
            const shard = this.shards.all.find(
              (item) => item.file === request.file,
            );
            if (!shard) {
              throw new Error("未知分片。");
            }

            return handle(
              { ...request, id: 0 },
              new WorkerTimings(),
              shard.db,
            ) as T;
          },
          drain: async () => {},
          close: async () => {},
          setTracer: () => {},
        }
      : new StoreWorkerQueue();

    // 导出历史必须保持只读；正常服务启动仍将无法确认结果的任务标为 interrupted。
    if (!options.readOnly && (options.interruptActive ?? true)) {
      const now = new Date().toISOString();
      for (const shard of this.shards.all) {
        shard.db
          .prepare(
            "UPDATE tasks SET status='interrupted',error='服务已重启，任务中断；未重放命令。',finishedAt=COALESCE(finishedAt,?) WHERE status IN ('queued','running','waiting')",
          )
          .run(now);
        shard.db
          .prepare(
            "UPDATE subagents SET status='interrupted',updatedAt=? WHERE status IN ('planned','queued','running')",
          )
          .run(now);
        shard.db
          .prepare(
            "UPDATE subagent_requests SET status='unknown' WHERE status='started'",
          )
          .run();
      }
    }

    // SQLite rowid 只在单一文件中单调；分片后显式分配全局事件游标，保持 SSE 增量读取兼容。
    this.nextEventId = this.shards.maxEventId() + 1;
  }

  setTracer(traces: TraceRecorder) {
    this.worker.setTracer(traces);
  }

  async drain() {
    await this.worker.drain();
  }

  /** 仅供本线程固定业务组合使用；第一次选择分片时取锁，禁止跨文件或异步回调。 */
  transaction<T>(work: () => T): T {
    if (this.transactionActive) {
      throw new Error("不允许嵌套历史事务。");
    }

    this.transactionActive = true;
    try {
      const value = work();
      if (value && typeof (value as { then?: unknown }).then === "function") {
        throw new Error("历史事务回调必须同步完成。");
      }

      this.transactionDatabase?.exec("COMMIT");

      return value;
    } catch (error) {
      try {
        if (this.transactionDatabase?.isTransaction) {
          this.transactionDatabase.exec("ROLLBACK");
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "历史事务回滚失败。", {
          cause: error,
        });
      }

      throw error;
    } finally {
      this.transactionActive = false;
      this.transactionDatabase = undefined;
    }
  }

  private enterShard(db: DatabaseSync) {
    if (this.transactionActive) {
      if (this.transactionDatabase && this.transactionDatabase !== db) {
        throw new Error("不支持跨分片历史事务。");
      }

      if (!this.transactionDatabase) {
        db.exec("BEGIN IMMEDIATE");
        this.transactionDatabase = db;
      }
    }

    this.db = db;
  }

  refresh() {
    this.shards.refresh();
  }

  checkpoint() {
    return this.shards.all.map((shard) => ({
      sequence: shard.sequence,
      ...shard.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(),
    }));
  }

  list() {
    return this.shards.all
      .flatMap(
        (shard) =>
          shard.db
            .prepare("SELECT * FROM sessions")
            .all() as unknown as Session[],
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string) {
    const shard = this.shards.findSession(id);
    if (!shard) {
      return undefined;
    }

    return shard.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as unknown as Session | undefined;
  }

  private sessionShard(sessionId: string) {
    return this.shards.findSession(sessionId);
  }

  private taskShard(taskId: string) {
    return this.shards.findTask(taskId);
  }

  private selectSession(sessionId: string) {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      throw new Error("会话不存在于历史分片中。");
    }

    this.enterShard(shard.db);

    return shard;
  }

  private selectTask(taskId: string) {
    const shard = this.taskShard(taskId);
    if (!shard) {
      throw new Error("任务不存在于历史分片中。");
    }

    this.enterShard(shard.db);

    return shard;
  }

  /** 未提供标题的新会话等待其首条 prompt；显式标题只供内部固定用途，不会被模型覆盖。 */
  create(workspace: string, title?: string) {
    const date = new Date().toISOString();
    const id = randomUUID();
    const manualTitle = title?.trim();
    const titleState = manualTitle ? "manual" : "pending";

    if (this.transactionActive) {
      throw new Error("创建会话不能嵌入既有分片事务。");
    }

    this.enterShard(this.shards.forNewSession().db);
    this.db
      .prepare(
        "INSERT INTO sessions(id,title,workspace,createdAt,updatedAt,titleState) VALUES(?,?,?,?,?,?)",
      )
      .run(id, manualTitle || "新对话", workspace, date, date, titleState);

    return this.get(id)!;
  }

  async createAsync(workspace: string, title?: string) {
    await this.worker.drain();
    const date = new Date().toISOString();
    const id = randomUUID();
    const manualTitle = title?.trim();
    const shard = this.shards.forNewSession();
    await this.worker.request<void>({
      operation: "write",
      file: shard.file,
      sessionId: id,
      writes: [
        {
          kind: "session",
          values: [
            id,
            manualTitle || "新对话",
            workspace,
            date,
            manualTitle ? "manual" : "pending",
          ],
        },
      ],
    });

    return this.get(id)!;
  }

  async startTaskAsync(
    sessionId: string,
    prompt: string,
    subagentsEnabled: boolean,
    recovery?: unknown,
  ) {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error("会话不存在。");
    }

    const firstPrompt =
      session.titleState === "pending" && !this.hasEvent(sessionId, "user");
    const taskId = randomUUID();
    const userId = this.nextEventId++;
    const recoveryId = recovery ? this.nextEventId++ : null;
    const date = new Date().toISOString();
    await this.worker.request<void>({
      operation: "write",
      file: this.selectSession(sessionId).file,
      sessionId,
      taskId,
      writes: [
        {
          kind: "task",
          values: [
            taskId,
            sessionId,
            date,
            Number(subagentsEnabled),
            prompt,
            recovery,
            firstPrompt,
            userId,
            recoveryId,
          ],
        },
      ],
    });

    return {
      task: this.task(taskId)!,
      firstPrompt,
      events: this.taskEvents(taskId),
    };
  }

  async titleAsync(
    sessionId: string,
    state: "completed" | "failed",
    title?: string,
    taskId?: string,
  ) {
    await this.worker.request<void>({
      operation: "write",
      file: this.selectSession(sessionId).file,
      sessionId,
      taskId,
      writes: [
        {
          kind: "title",
          values: [state, title ?? null, new Date().toISOString(), sessionId],
        },
      ],
    });
  }

  /** 以条件更新领取标题任务，避免重试、恢复或并发调用使用后续 prompt 覆盖首条消息。 */
  startTitleGeneration(sessionId: string) {
    this.selectSession(sessionId);
    const result = this.db
      .prepare(
        "UPDATE sessions SET titleState='generating' WHERE id=? AND titleState='pending'",
      )
      .run(sessionId);

    return result.changes === 1;
  }

  /** 标题成功后与更新时间一起持久化，供会话列表和当前快照刷新。 */
  completeTitleGeneration(sessionId: string, title: string) {
    this.selectSession(sessionId);
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
    this.selectSession(sessionId);
    this.db
      .prepare(
        "UPDATE sessions SET titleState='failed' WHERE id=? AND titleState='generating'",
      )
      .run(sessionId);
  }

  tasks(sessionId: string) {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return [];
    }

    return shard.db
      .prepare(
        "SELECT * FROM tasks WHERE sessionId=? ORDER BY createdAt, orderKey",
      )
      .all(sessionId)
      .map((row) => this.readTask(row as unknown as TaskRow));
  }

  /** 首条消息判断只需要存在性，不能为此把长工具输出逐条 JSON.parse 到主线程。 */
  hasEvent(sessionId: string, type: string) {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return false;
    }

    return Boolean(
      shard.db
        .prepare("SELECT 1 FROM events WHERE sessionId=? AND type=? LIMIT 1")
        .get(sessionId, type),
    );
  }

  /** 恢复只读取目标任务的一条已知事件；大历史继续通过 eventsAsync 在线程外读取。 */
  taskEvent(taskId: string, type: string) {
    const shard = this.taskShard(taskId);
    if (!shard) {
      return undefined;
    }

    const row = shard.db
      .prepare(
        "SELECT data FROM events WHERE taskId=? AND type=? ORDER BY id LIMIT 1",
      )
      .get(taskId, type) as { data: string } | undefined;

    return row ? JSON.parse(row.data) : undefined;
  }

  task(id: string) {
    const shard = this.taskShard(id);
    if (!shard) {
      return undefined;
    }

    const row = shard.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);

    return row ? this.readTask(row as unknown as TaskRow) : undefined;
  }

  /** replay 导出只读取单个任务的事件，避免将同会话其他任务的历史混入 case。 */
  taskEvents(taskId: string) {
    const shard = this.taskShard(taskId);
    if (!shard) {
      return [];
    }

    return shard.db
      .prepare(
        "SELECT id,sessionId,taskId,type,data,createdAt FROM events WHERE taskId=? ORDER BY id",
      )
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
    this.selectTask(task.id);
    writeReplay(this.db, task.id, "create", null, capture);
  }

  async replayAsync(
    taskId: string,
    action:
      | "create"
      | "modelStart"
      | "modelFinish"
      | "toolStart"
      | "toolFinish"
      | "finish",
    key: string | null,
    data: unknown,
  ) {
    const task = this.task(taskId);
    if (!task) {
      throw new Error("任务不存在于历史分片中。");
    }

    await this.worker.request<void>({
      operation: "write",
      file: this.selectTask(taskId).file,
      sessionId: task.sessionId,
      taskId,
      writes: [{ kind: "replay", values: [taskId, action, key, data] }],
    });
  }

  private replayCapture(taskId: string) {
    const shard = this.taskShard(taskId);

    return shard ? readReplayCapture(shard.db, taskId) : undefined;
  }

  startReplayModelExchange(taskId: string, exchange: RecordedModelExchange) {
    this.selectTask(taskId);
    writeReplay(this.db, taskId, "modelStart", null, exchange);
  }

  finishReplayModelExchange(
    taskId: string,
    id: string,
    outcome: Pick<RecordedModelExchange, "response" | "error">,
  ) {
    this.selectTask(taskId);
    writeReplay(this.db, taskId, "modelFinish", id, outcome);
  }

  startReplayTool(taskId: string, tool: RecordedToolCall) {
    this.selectTask(taskId);
    writeReplay(this.db, taskId, "toolStart", null, tool);
  }

  finishReplayTool(taskId: string, callId: string, result: unknown) {
    this.selectTask(taskId);
    writeReplay(this.db, taskId, "toolFinish", callId, result);
  }

  finishReplayCapture(taskId: string, status: TaskStatus) {
    this.selectTask(taskId);
    writeReplay(this.db, taskId, "finish", null, status);
  }

  /** 新捕获优先使用未截断工具材料；旧历史退回事件配对，但 source 必须明确标为 legacy。 */
  replayCase(taskId: string): TaskReplayCase | undefined {
    if (!this.task(taskId)) {
      return undefined;
    }

    const db = this.selectTask(taskId).db;
    db.exec("BEGIN");
    try {
      return this.readReplayCase(taskId);
    } finally {
      db.exec("COMMIT");
    }
  }

  private readReplayCase(taskId: string): TaskReplayCase | undefined {
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
      tools: completeReplayTools(
        capture?.modelExchanges ?? [],
        tools,
        this.subagents(taskId),
      ),
      events,
    };
  }

  /** SQLite 布尔值必须在所有读路径转换，否则刷新后 UI 会把数字误当任务选项。 */
  private readTask<T extends TaskRow>(row: T): Task & Omit<T, keyof TaskRow> {
    const task = { ...row };
    delete task.orderKey;

    return { ...task, subagentsEnabled: row.subagentsEnabled === 1 } as Task &
      Omit<T, keyof TaskRow>;
  }

  /** 同一会话的上下文不能并发追加；不同会话的任务由 Engine 不限目录与数量地并行调度。 */
  hasUnfinishedTask(sessionId: string) {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return false;
    }

    return Boolean(
      shard.db
        .prepare(
          "SELECT 1 FROM tasks WHERE sessionId=? AND status IN ('queued','running','waiting') LIMIT 1",
        )
        .get(sessionId),
    );
  }

  /** 待启动顺序按创建时间稳定；Engine 依次领取，跳过正在取消的项。 */
  queuedTasks() {
    return this.shards.all
      .flatMap((shard) =>
        shard.db
          .prepare(
            "SELECT tasks.*,sessions.workspace FROM tasks JOIN sessions ON sessions.id=tasks.sessionId WHERE tasks.status='queued'",
          )
          .all()
          .map((row) =>
            this.readTask(row as unknown as TaskRow & { workspace: string }),
          ),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  createTask(sessionId: string, subagentsEnabled = false) {
    this.selectSession(sessionId);
    const task = {
      id: randomUUID(),
      sessionId,
      status: "queued" as TaskStatus,
      subagentsEnabled,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        "INSERT INTO tasks(id,sessionId,status,createdAt,subagentsEnabled) VALUES(?,?,?,?,?)",
      )
      .run(
        task.id,
        sessionId,
        task.status,
        task.createdAt,
        Number(subagentsEnabled),
      );

    return task;
  }

  /** 计划连同事件在同一会话分片提交；无效结构、旧 ID 或重复规划不启动任何 Worker。 */
  planSubagents(taskId: string, plans: SubtaskPlan[]) {
    const task = this.task(taskId);
    if (!task?.subagentsEnabled || task.status !== "running") {
      throw new Error("当前任务未开启 subagent 或尚未运行。");
    }

    return this.transaction(() => {
      const existing = new Set(this.subagents(taskId).map((agent) => agent.id));
      validateSubagentPlan(plans, existing);
      const now = new Date().toISOString();
      this.selectTask(taskId);
      const statement = this.db.prepare(
        "INSERT INTO subagents(taskId,id,status,plan,updatedAt) VALUES(?,?,?,?,?)",
      );
      for (const plan of plans) {
        statement.run(taskId, plan.id, "planned", JSON.stringify(plan), now);
      }

      this.event(task.sessionId, taskId, "subagent_plan", {
        subtasks: plans.map(({ id, role, dependsOn }) => ({
          id,
          role,
          dependsOn,
        })),
      });

      return this.subagents(taskId);
    });
  }

  subagents(taskId: string): SubagentRecord[] {
    const shard = this.taskShard(taskId);
    if (!shard) {
      return [];
    }

    return shard.db
      .prepare(
        "SELECT taskId,id,status,plan,report,context,consumed,updatedAt FROM subagents WHERE taskId=? ORDER BY orderKey",
      )
      .all(taskId)
      .map((raw) => {
        const row = raw as {
          taskId: string;
          id: string;
          status: SubagentStatus;
          plan: string;
          report: string | null;
          context: string;
          consumed: number;
          updatedAt: string;
        };

        return {
          ...row,
          plan: JSON.parse(row.plan) as SubtaskPlan,
          context: JSON.parse(row.context) as unknown[],
          consumed: row.consumed === 1,
        };
      });
  }

  /** 仅状态转移与落盘检查点；持久化结果确认后才可让子 loop 进入下一个模型轮次。 */
  updateSubagent(
    taskId: string,
    id: string,
    status: SubagentStatus,
    context: unknown[],
    report?: string,
  ) {
    return this.transaction(() => {
      this.selectTask(taskId);
      const current = this.subagents(taskId).find((agent) => agent.id === id);
      if (
        !current ||
        ["completed", "failed", "cancelled", "interrupted"].includes(
          current.status,
        )
      ) {
        throw new Error("subagent 不存在或已经结束。");
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE subagents SET status=?,context=?,report=?,updatedAt=? WHERE taskId=? AND id=?",
        )
        .run(
          status,
          JSON.stringify(context),
          report ?? current.report,
          now,
          taskId,
          id,
        );

      this.event(this.task(taskId)!.sessionId, taskId, "subagent_state", {
        id,
        status,
      });
    });
  }

  /** 预览不可变报告不消费它；主模型工具反馈可能尚未持久化。 */
  collectSubagents(taskId: string, ids: string[]) {
    const task = this.task(taskId);
    if (
      !task ||
      !task.subagentsEnabled ||
      ids.length < 1 ||
      new Set(ids).size !== ids.length
    ) {
      throw new Error("collect 必须指定当前任务中不同的 subagent ID。");
    }

    const all = this.subagents(taskId);
    const selected = ids.map((id) => {
      const record = all.find((agent) => agent.id === id);
      if (!record) {
        throw new Error("不能收集另一任务的 subagent 报告。");
      }

      return record;
    });

    return selected.map(({ id, status, consumed, report }) => ({
      id,
      status,
      report: ["completed", "failed", "cancelled", "interrupted"].includes(
        status,
      )
        ? report
        : null,
      consumed,
    }));
  }

  /** 同一事务提交工具反馈与实际交付的报告；晚完成的报告不在旧预览中，不能误标消费。 */
  commitCollectedToolResult(
    taskId: string,
    ids: string[],
    deliveredReports: ReturnType<Store["collectSubagents"]>,
    data: unknown,
    feedback: unknown,
    callId: string,
    replayResult: unknown,
  ) {
    let event: Event | undefined;
    this.commitSubagentCollect(
      taskId,
      ids,
      () => {
        const sessionId = this.task(taskId)!.sessionId;
        event = this.event(sessionId, taskId, "tool_result", data);
        this.finishReplayTool(taskId, callId, replayResult);
        this.appendContext(sessionId, [feedback]);
      },
      deliveredReports,
    );

    return event!;
  }

  commitSubagentCollect(
    taskId: string,
    ids: string[],
    persistOutput: () => unknown,
    deliveredReports: ReturnType<Store["collectSubagents"]>,
  ) {
    return this.transaction(() => {
      const reports = this.collectSubagents(taskId, ids);
      const result = persistOutput();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("报告提交回调必须同步完成。");
      }

      this.selectTask(taskId);
      const statement = this.db.prepare(
        "UPDATE subagents SET consumed=1 WHERE taskId=? AND id=? AND consumed=0",
      );
      const newlyConsumed =
        JSON.stringify(deliveredReports) === JSON.stringify(reports)
          ? reports
              .filter(({ report, consumed }) => report !== null && !consumed)
              .map(({ id }) => id)
          : [];
      for (const id of newlyConsumed) {
        statement.run(taskId, id);
      }

      this.event(this.task(taskId)!.sessionId, taskId, "subagent_collect", {
        ids: newlyConsumed,
      });

      return reports;
    });
  }

  /** 子问题与回执同事务提交；相同请求只返回已确认的原始问题，不创建第二条事件。 */
  recordSubagentQuestion(
    taskId: string,
    subagentId: string,
    requestId: string,
    question: string,
  ) {
    if (!requestId || requestId.length > 128 || !question.trim()) {
      throw new Error("subagent 问题不能为空，请求 ID 必须有效。");
    }

    return this.transaction(() => {
      const prior = this.subagentRequest(taskId, subagentId, requestId);
      if (prior) {
        const receipt = prior.result as {
          id: number;
          subagentId: string;
          question: string;
        } | null;
        if (
          prior.status === "completed" &&
          receipt?.subagentId === subagentId &&
          receipt.question === question &&
          Number.isSafeInteger(receipt.id)
        ) {
          return receipt;
        }

        throw new Error("subagent 问题请求重复、内容冲突或结果未知。");
      }

      const task = this.task(taskId);
      const child = this.subagents(taskId).find(({ id }) => id === subagentId);
      if (
        !task?.subagentsEnabled ||
        task.status !== "running" ||
        child?.status !== "running"
      ) {
        throw new Error("subagent 问题只允许本任务运行中的子线程提交。");
      }

      this.startSubagentRequest(taskId, subagentId, requestId, "question");
      const event = this.event(task.sessionId, taskId, "subagent_question", {
        subagentId,
        question,
      });
      const receipt = { id: event.id, subagentId, question };
      this.finishSubagentRequest(taskId, subagentId, requestId, receipt);

      return receipt;
    });
  }

  /** 请求 ID 在同一子任务中只能启动一次；结果未知不会被当作从未执行。 */
  subagentRequest(taskId: string, subagentId: string, requestId: string) {
    const shard = this.taskShard(taskId);
    if (!shard) {
      return undefined;
    }

    const row = shard.db
      .prepare(
        "SELECT status,result FROM subagent_requests WHERE taskId=? AND subagentId=? AND requestId=?",
      )
      .get(taskId, subagentId, requestId) as
      { status: string; result: string | null } | undefined;

    return row
      ? {
          status: row.status,
          result: row.result === null ? null : JSON.parse(row.result),
        }
      : undefined;
  }

  startSubagentRequest(
    taskId: string,
    subagentId: string,
    requestId: string,
    kind: string,
  ) {
    this.selectTask(taskId);
    this.db
      .prepare(
        "INSERT INTO subagent_requests(taskId,subagentId,requestId,kind,status) VALUES(?,?,?,?,?)",
      )
      .run(taskId, subagentId, requestId, kind, "started");
  }

  finishSubagentRequest(
    taskId: string,
    subagentId: string,
    requestId: string,
    result: unknown,
  ) {
    const payload = JSON.stringify(result);
    if (!payload) {
      throw new Error("subagent 请求结果为空。");
    }

    this.selectTask(taskId);
    const updated = this.db
      .prepare(
        "UPDATE subagent_requests SET status='completed',result=? WHERE taskId=? AND subagentId=? AND requestId=? AND status='started'",
      )
      .run(payload, taskId, subagentId, requestId);
    if (updated.changes !== 1) {
      throw new Error("subagent 请求不在可确认状态。");
    }
  }

  /** 首次进入 running 时记实际开始时间；排队等待不计入运行统计，终态只在真正结束时记录。 */
  status(id: string, status: TaskStatus, error?: string) {
    this.selectTask(id);
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
    if (!this.transactionActive) {
      return this.transaction(() => this.event(sessionId, taskId, type, data));
    }

    this.selectSession(sessionId);
    const createdAt = new Date().toISOString();
    const id = this.nextEventId;
    this.db
      .prepare(
        "INSERT INTO events(id,sessionId,taskId,type,data,createdAt) VALUES(?,?,?,?,?,?)",
      )
      .run(id, sessionId, taskId, type, JSON.stringify(data), createdAt);
    this.nextEventId++;
    appendStatistics(this.db, { id, sessionId, taskId, type, data, createdAt });

    this.db
      .prepare("UPDATE sessions SET updatedAt=? WHERE id=?")
      .run(createdAt, sessionId);

    return {
      id,
      sessionId,
      taskId,
      type,
      data,
      createdAt,
    };
  }

  /** 仅在 Worker 提交确认之后返回事件，供 Engine 再向 SSE 发布。 */
  async eventAsync(
    sessionId: string,
    taskId: string,
    type: string,
    data: unknown,
  ): Promise<Event> {
    const id = this.nextEventId++;
    const createdAt = new Date().toISOString();
    const file = this.selectSession(sessionId).file;
    await this.worker.request<void>({
      operation: "write",
      file,
      sessionId,
      taskId,
      writes: [
        {
          kind: "event",
          values: [id, sessionId, taskId, type, data, createdAt],
        },
      ],
    });

    return { id, sessionId, taskId, type, data, createdAt };
  }

  async persistToolResultAsync(
    sessionId: string,
    taskId: string,
    data: unknown,
    feedback: unknown,
    callId: string,
    replayResult: unknown,
  ) {
    const id = this.nextEventId++;
    const createdAt = new Date().toISOString();
    await this.worker.request<void>({
      operation: "write",
      file: this.selectSession(sessionId).file,
      sessionId,
      taskId,
      writes: [
        {
          kind: "event",
          values: [id, sessionId, taskId, "tool_result", data, createdAt],
        },
        {
          kind: "replay",
          values: [taskId, "toolFinish", callId, replayResult],
        },
        { kind: "context", values: [sessionId, [feedback]] },
      ],
    });

    return {
      id,
      sessionId,
      taskId,
      type: "tool_result",
      data,
      createdAt,
    } as Event;
  }

  /** 锚点只有指纹和计数；读写仍经队列，重启或跨分片不会读取未提交值。 */
  async tokenAnchorAsync(
    sessionId: string,
    taskId?: string,
  ): Promise<TokenAnchor | undefined> {
    const value = await this.runWorker<unknown>({
      operation: "tokenAnchor",
      file: this.selectSession(sessionId).file,
      sessionId,
      taskId,
    });
    const parsed = tokenAnchorSchema.safeParse(value);

    return parsed.success ? parsed.data : undefined;
  }

  async saveTokenAnchorAsync(
    sessionId: string,
    anchor: TokenAnchor,
    taskId?: string,
  ) {
    const value = tokenAnchorSchema.parse(anchor);
    await this.worker.request<void>({
      operation: "write",
      file: this.selectSession(sessionId).file,
      sessionId,
      taskId,
      writes: [{ kind: "tokenAnchor", values: [sessionId, value] }],
    });
  }

  async appendContextAsync(sessionId: string, items: any[], taskId?: string) {
    if (!items.length) {
      return;
    }

    await this.worker.request<void>({
      operation: "write",
      file: this.selectSession(sessionId).file,
      sessionId,
      taskId,
      writes: [{ kind: "context", values: [sessionId, items] }],
    });
  }

  async saveContextAsync(sessionId: string, items: any[], taskId?: string) {
    await this.worker.request<void>({
      operation: "write",
      file: this.selectSession(sessionId).file,
      sessionId,
      taskId,
      writes: [{ kind: "contextReplace", values: [sessionId, items] }],
    });
  }

  async statusAsync(id: string, status: TaskStatus, error?: string) {
    const task = this.task(id);
    if (!task) {
      throw new Error("任务不存在于历史分片中。");
    }

    const now = new Date().toISOString();
    await this.worker.request<void>({
      operation: "write",
      file: this.selectTask(id).file,
      sessionId: task.sessionId,
      taskId: id,
      writes: [
        {
          kind: "status",
          values: [
            status,
            error ?? null,
            status === "running" ? now : null,
            ["completed", "failed", "cancelled", "interrupted"].includes(status)
              ? now
              : null,
            id,
          ],
        },
      ],
    });
  }

  events(sessionId: string, after = 0) {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return [];
    }

    return shard.db
      .prepare(
        "SELECT id,sessionId,taskId,type,data,createdAt FROM events WHERE sessionId=? AND id>? ORDER BY id",
      )
      .all(sessionId, after)
      .map((r) => ({ ...r, data: JSON.parse(String(r.data)) })) as Event[];
  }

  /** 全部事件正文经异步队列读取；不在主线程扫描长度或按载荷大小分叉。 */
  async eventsAsync(sessionId: string, after = 0): Promise<Event[]> {
    const shard = this.sessionShard(sessionId);

    return shard
      ? this.runWorker<Event[]>({
          operation: "events",
          file: shard.file,
          sessionId,
          after,
        })
      : [];
  }

  /** 恢复与两条压缩路径读取完整相关事件，不受 UI 页大小影响，不消除重复 call ID。 */
  async relevantEventsAsync(sessionId: string): Promise<Event[]> {
    const shard = this.selectSession(sessionId);

    return this.worker.request<Event[]>({
      operation: "relevantEvents",
      file: shard.file,
      sessionId,
    });
  }

  statistics(sessionId: string) {
    return readStatistics(
      this.selectSession(sessionId).db,
      sessionId,
    ).snapshot();
  }

  taskPage(sessionId: string, before?: string) {
    const db = this.selectSession(sessionId).db;
    const cursor = before
      ? db
          .prepare(
            "SELECT createdAt,orderKey FROM tasks WHERE sessionId=? AND id=?",
          )
          .get(sessionId, before)
      : undefined;
    if (before && !cursor) {
      throw new Error("任务游标无效。");
    }

    const rows = db
      .prepare(
        "SELECT * FROM tasks WHERE sessionId=? AND (createdAt,orderKey)<(?,?) ORDER BY createdAt DESC,orderKey DESC LIMIT 101",
      )
      .all(
        sessionId,
        cursor?.createdAt ?? "\uffff",
        cursor?.orderKey ?? Number.MAX_SAFE_INTEGER,
      );
    const tasks = (rows.slice(0, 100) as unknown as TaskRow[])
      .map((row) => this.readTask(row))
      .reverse();

    return { tasks, hasOlder: rows.length > 100, next: tasks[0]?.id };
  }

  replayDirectory(taskId: string, after = 0) {
    const db = this.selectTask(taskId).db;
    db.exec("BEGIN");
    try {
      const row = db
        .prepare("SELECT data FROM task_replays WHERE taskId=?")
        .get(taskId);
      const entries = db
        .prepare(
          "SELECT seq,kind,itemId,substr(json_extract(data,'$.purpose'),1,120) AS purpose,byteSize,outcomeBytes,outcome IS NOT NULL AS finished FROM replay_entries WHERE taskId=? AND seq>? ORDER BY seq LIMIT 101",
        )
        .all(taskId, after);

      return {
        captured: Boolean(row),
        metadata: row ? JSON.parse(String(row.data)) : null,
        entries: entries.slice(0, 100),
        next: entries.length > 100 ? Number(entries[99]!.seq) : null,
      };
    } finally {
      db.exec("COMMIT");
    }
  }

  replayEntry(taskId: string, kind: "model" | "tool", itemId: string) {
    const db = this.selectTask(taskId).db;
    db.exec("BEGIN");
    try {
      if (kind === "model") {
        return readReplayExchange(db, taskId, itemId);
      }

      const row = db
        .prepare(
          "SELECT data,outcome FROM replay_entries WHERE taskId=? AND kind='tool' AND itemId=?",
        )
        .get(taskId, itemId);

      return row
        ? {
            ...JSON.parse(String(row.data)),
            ...(row.outcome === null ? {} : JSON.parse(String(row.outcome))),
          }
        : undefined;
    } finally {
      db.exec("COMMIT");
    }
  }

  relatedEvents(sessionId: string, taskId: string, callId: string, after = 0) {
    return this.selectSession(sessionId)
      .db.prepare(
        "SELECT id,sessionId,taskId,type,createdAt,byteSize AS bodyBytes FROM events WHERE sessionId=? AND taskId=? AND callId=? AND id>? ORDER BY id LIMIT 100",
      )
      .all(sessionId, taskId, callId, after)
      .map((row) => ({
        ...row,
        data: { callId },
        bodyDeferred: true,
      })) as unknown as Event[];
  }

  snapshotPage(
    sessionId: string,
    options: {
      before?: number;
      after?: number;
      highWater?: number;
      limit?: number;
    } = {},
  ) {
    const db = this.selectSession(sessionId).db;
    db.exec("BEGIN");
    try {
      const { events, ...history } = this.historyPage(sessionId, options);
      const tasks = this.tasks(sessionId);
      const base = prepareSessionStatistics(
        this.statistics(sessionId),
        tasks,
      )(0);
      const runningStarts = tasks
        .filter(
          (task) =>
            ["running", "waiting"].includes(task.status) &&
            task.startedAt !== null,
        )
        .map((task) => Date.parse(task.startedAt ?? task.createdAt))
        .filter(Number.isFinite);

      return {
        session: this.get(sessionId),
        events,
        history,
        tasks: tasks.slice(-200),
        statisticsProjection: { base, runningStarts },
      };
    } finally {
      db.exec("COMMIT");
    }
  }

  historyPage(
    sessionId: string,
    options: {
      before?: number;
      after?: number;
      highWater?: number;
      limit?: number;
    },
  ) {
    const db = this.selectSession(sessionId).db;
    const own = !db.isTransaction;
    if (own) {
      db.exec("BEGIN");
    }

    try {
      const highWater =
        options.highWater ??
        Number(
          db
            .prepare(
              "SELECT coalesce(max(id),0) AS id FROM events WHERE sessionId=?",
            )
            .get(sessionId)!.id,
        );
      const limit = Math.max(1, Math.min(200, options.limit ?? 100));
      const forward = options.after !== undefined && options.after > 0;
      const rows = db
        .prepare(
          `SELECT id,sessionId,taskId,type,createdAt,byteSize,
        CASE WHEN byteSize<=32768 THEN data ELSE json_object('name',substr(toolName,1,120),'callId',substr(callId,1,120),'text',substr(json_extract(data,'$.text'),1,512)) END AS data
        FROM events WHERE sessionId=? AND id<=? AND id>? AND id<? ORDER BY id ${forward ? "ASC" : "DESC"} LIMIT ?`,
        )
        .all(
          sessionId,
          highWater,
          options.after ?? 0,
          options.before ?? Number.MAX_SAFE_INTEGER,
          limit + 1,
        );
      const more = rows.length > limit;
      const selected = rows.slice(0, limit);
      if (!forward) {
        selected.reverse();
      }

      const events = selected.map(({ byteSize, ...row }) => ({
        ...row,
        data: JSON.parse(String(row.data)),
        ...(Number(byteSize) > 32768
          ? { bodyDeferred: true, bodyBytes: Number(byteSize) }
          : {}),
      })) as unknown as Event[];

      return {
        events,
        highWater,
        hasOlder: !forward && more,
        hasNewer: forward && more,
        cursor: forward && more ? events.at(-1)!.id : highWater,
      };
    } finally {
      if (own) {
        db.exec("COMMIT");
      }
    }
  }

  eventBody(sessionId: string, id: number, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("正文位置无效。");
    }

    const row = this.selectSession(sessionId)
      .db.prepare(
        "SELECT substr(data,?,16384) AS text,length(data) AS total FROM events WHERE sessionId=? AND id=?",
      )
      .get(offset + 1, sessionId, id);
    if (!row) {
      throw new Error("事件不存在。");
    }

    return {
      text: String(row.text),
      next: offset + 16384 < Number(row.total) ? offset + 16384 : null,
    };
  }

  context(id: string): any[] {
    const shard = this.sessionShard(id);
    if (!shard) {
      return [];
    }

    const rows = shard.db
      .prepare(
        "SELECT items FROM context_chunks WHERE sessionId=? ORDER BY position",
      )
      .all(id) as Array<{ items: string }>;

    return rows.flatMap((row) => JSON.parse(row.items) as any[]);
  }

  /** 完整活动上下文统一在线程外解析；读操作排在已接受写入之后。 */
  async contextAsync(id: string): Promise<any[]> {
    const shard = this.sessionShard(id);

    return shard
      ? this.runWorker<any[]>({
          operation: "context",
          file: shard.file,
          sessionId: id,
        })
      : [];
  }

  /** 仅在显式替换活动历史（例如测试初始化）时建立基线；正常模型/工具反馈使用 appendContext。 */
  saveContext(id: string, items: any[]) {
    this.selectSession(id);
    this.db.exec("SAVEPOINT replace_context");
    try {
      this.db
        .prepare("DELETE FROM context_token_anchors WHERE sessionId=?")
        .run(id);
      this.db.prepare("DELETE FROM context_chunks WHERE sessionId=?").run(id);
      this.db
        .prepare(
          "INSERT INTO context_chunks(sessionId,position,items) VALUES(?,0,?)",
        )
        .run(id, JSON.stringify(items));
      this.db.exec("RELEASE replace_context");
    } catch (error) {
      this.db.exec("ROLLBACK TO replace_context");
      this.db.exec("RELEASE replace_context");
      throw error;
    }
  }

  /** 在调用方的事件事务中追加一批协议项；空批次不产生记录。 */
  appendContext(id: string, items: any[]) {
    if (items.length === 0) {
      return;
    }

    this.selectSession(id);
    this.db
      .prepare(
        "INSERT INTO context_chunks(sessionId,position,items) VALUES(?,(SELECT COALESCE(MAX(position)+1,0) FROM context_chunks WHERE sessionId=?),?)",
      )
      .run(id, id, JSON.stringify(items));
  }

  latestContextSnapshot(sessionId: string): ContextSnapshot | undefined {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return undefined;
    }

    const row = shard.db
      .prepare(
        "SELECT data FROM context_snapshots WHERE sessionId=? ORDER BY orderKey DESC LIMIT 1",
      )
      .get(sessionId);

    return row ? JSON.parse(String(row.data)) : undefined;
  }

  contextSnapshot(sessionId: string, id: string): ContextSnapshot | undefined {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return undefined;
    }

    const row = shard.db
      .prepare("SELECT data FROM context_snapshots WHERE sessionId=? AND id=?")
      .get(sessionId, id);

    return row ? JSON.parse(String(row.data)) : undefined;
  }

  /** 父快照按显式插入顺序读取，正文统一在线程外解析。 */
  async latestContextSnapshotAsync(sessionId: string) {
    const shard = this.sessionShard(sessionId);

    return shard
      ? this.runWorker<ContextSnapshot | undefined>({
          operation: "latestSnapshot",
          file: shard.file,
          sessionId,
        })
      : undefined;
  }

  /** 历史回读按会话校验快照身份，不能读取其他会话的 source。 */
  async contextSnapshotAsync(sessionId: string, id: string) {
    const shard = this.sessionShard(sessionId);

    return shard
      ? this.runWorker<ContextSnapshot | undefined>({
          operation: "snapshot",
          file: shard.file,
          sessionId,
          snapshotId: id,
        })
      : undefined;
  }

  /** 快照和活动上下文在线程外序列化并在同一事务提交；主线程不会因大 JSON 或磁盘等待失去 API 响应。 */
  async compactContextAsync(
    sessionId: string,
    snapshot: ContextSnapshot,
    input: any[],
  ) {
    if (snapshot.sessionId !== sessionId) {
      throw new Error("压缩快照不属于目标会话。");
    }

    if (
      snapshot.parentId !== null &&
      !(await this.contextSnapshotAsync(sessionId, snapshot.parentId))
    ) {
      throw new Error("压缩快照的父快照不属于目标会话。");
    }

    await this.worker.request<void>({
      operation: "compact",
      file: this.selectSession(sessionId).file,
      sessionId,
      snapshot,
      input,
    });
  }

  /** 所有异步读写都经过同一队列，保证先写后读及压缩原子提交的顺序。 */
  private runWorker<T>(request: Omit<StoreWorkerRequest, "id">): Promise<T> {
    return this.worker.request<T>(request);
  }

  closeAsync(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await this.worker.close();
      } finally {
        this.shards.close();
      }
    })();

    return this.closing;
  }

  close() {
    return this.closeAsync();
  }
}
