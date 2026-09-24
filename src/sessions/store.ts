/**
 * 用 SQLite 保存会话、任务、事件和模型上下文，供 Engine、HTTP 接口和 ContextManager 使用。
 *
 * 1. 构造器发现兼容的 history.sqlite 与后续容量分片，在每个文件初始化数据库并把重启前未完成的任务标为 interrupted；transaction 同步提交，取锁或执行失败时释放本次已开启的事务。
 * 2. list/get/create 跨分片定位或聚合会话；新会话在最新分片达到容量上限后进入新文件，已有会话始终写回其初始分片。标题状态的领取、完成或失败保证首条 prompt 只生成一次标题。
 * 3. tasks/task/createTask/status 读写任务状态与不可变的 subagent 选择；旧分片逐个迁移，SQLite 的 0/1 在各读取入口转换为布尔值。queuedTasks 和 hasUnfinishedTask 供 Engine 调度跨会话队列，event/events 保存和分页读取事件。
 * 4. subagents/subagent_requests 按任务存计划、检查点、状态、子问题事件及请求回执，重启只中断未完成子任务；task_replays 保存可审计的模型/工具材料。
 * 5. 旧 context 行在备份后原样迁入 context_chunks 基线；appendContext 只写新增批次，saveContext/压缩替换基线，读时按顺序重建；大记录由 store-worker 解析。
 * 6. close 由应用退出流程调用，关闭全部历史分片连接；Worker 自己打开目标会话分片的短生命周期 WAL 连接，不持有 Store 的连接。
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
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
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

type TaskRow = Omit<Task, "subagentsEnabled"> & { subagentsEnabled: number };

export class Store {
  db: DatabaseSync;
  private readonly shards: HistoryShards;
  private nextEventId: number;

  constructor(
    file: string,
    options: { interruptActive?: boolean; maxShardBytes?: number } = {},
  ) {
    this.shards = new HistoryShards(
      file,
      options.maxShardBytes ?? DEFAULT_HISTORY_SHARD_MAX_BYTES,
    );
    this.db = this.shards.active().db;
    for (const shard of this.shards.all) {
      this.migrate(shard.db);
    }

    // 导出历史必须保持只读；正常服务启动仍将无法确认结果的任务标为 interrupted。
    if (options.interruptActive ?? true) {
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

  /** 将历史会话标为完成，避免升级后用旧消息意外覆盖用户原有标题。 */
  private migrate(db: DatabaseSync) {
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === "titleState")) {
      db.exec(
        "ALTER TABLE sessions ADD COLUMN titleState TEXT NOT NULL DEFAULT 'completed'",
      );
    }

    const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
    }>;
    if (!taskColumns.some((column) => column.name === "startedAt")) {
      db.exec("ALTER TABLE tasks ADD COLUMN startedAt TEXT");
    }

    if (!taskColumns.some((column) => column.name === "finishedAt")) {
      db.exec("ALTER TABLE tasks ADD COLUMN finishedAt TEXT");
    }

    if (!taskColumns.some((column) => column.name === "subagentsEnabled")) {
      db.exec(
        "ALTER TABLE tasks ADD COLUMN subagentsEnabled INTEGER NOT NULL DEFAULT 0 CHECK (subagentsEnabled IN (0, 1))",
      );
    }

    // 直接复制原始 JSON，既不重建历史也不把 UI 事件误当成模型协议项。
    // INSERT/DELETE 必须同一事务：中断后重启只会看到旧行或新基线。
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "INSERT INTO context_chunks(sessionId,position,items) SELECT sessionId,0,items FROM context WHERE NOT EXISTS (SELECT 1 FROM context_chunks WHERE context_chunks.sessionId=context.sessionId)",
      );
      db.exec(
        "DELETE FROM context WHERE sessionId IN (SELECT sessionId FROM context_chunks)",
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 回调必须同步完成，不能在事务中等待网络或其他异步操作。 */
  transaction<T>(work: () => T): T {
    const transactionShards: DatabaseSync[] = [];
    try {
      // 后续分片可能正由压缩 Worker 写入；取锁失败也必须释放已取得的事务。
      for (const shard of this.shards.all) {
        shard.db.exec("BEGIN IMMEDIATE");
        transactionShards.push(shard.db);
      }

      const value = work();
      for (const db of transactionShards) {
        db.exec("COMMIT");
      }

      return value;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const db of transactionShards.reverse()) {
        try {
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "历史事务回滚失败。",
          {
            cause: error,
          },
        );
      }

      throw error;
    }
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

    this.db = shard.db;

    return shard;
  }

  private selectTask(taskId: string) {
    const shard = this.taskShard(taskId);
    if (!shard) {
      throw new Error("任务不存在于历史分片中。");
    }

    this.db = shard.db;

    return shard;
  }

  /** 未提供标题的新会话等待其首条 prompt；显式标题只供内部固定用途，不会被模型覆盖。 */
  create(workspace: string, title?: string) {
    const date = new Date().toISOString();
    const id = randomUUID();
    const manualTitle = title?.trim();
    const titleState = manualTitle ? "manual" : "pending";

    this.db = this.shards.forNewSession().db;
    this.db
      .prepare(
        "INSERT INTO sessions(id,title,workspace,createdAt,updatedAt,titleState) VALUES(?,?,?,?,?,?)",
      )
      .run(id, manualTitle || "新对话", workspace, date, date, titleState);

    return this.get(id)!;
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
        "SELECT * FROM tasks WHERE sessionId=? ORDER BY createdAt, rowid",
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
    this.selectTask(task.id);
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
    const shard = this.taskShard(taskId);
    if (!shard) {
      return undefined;
    }

    const row = shard.db
      .prepare("SELECT data FROM task_replays WHERE taskId=?")
      .get(taskId) as { data: string } | undefined;

    return row ? (JSON.parse(row.data) as TaskReplayCapture) : undefined;
  }

  private saveReplayCapture(taskId: string, capture: TaskReplayCapture) {
    this.selectTask(taskId);
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

  /** SQLite 布尔值必须在所有读路径转换，否则刷新后 UI 会把数字误当任务选项。 */
  private readTask<T extends TaskRow>(row: T): Task & Omit<T, keyof TaskRow> {
    return { ...row, subagentsEnabled: row.subagentsEnabled === 1 };
  }

  /** 同一会话的上下文不能并发追加；不同会话的任务由 Engine 依据工作区和全局上限调度。 */
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

  /** 排队顺序按创建时间稳定；Engine 可跳过被相同工作区锁阻塞的项，避免空闲并发槽位闲置。 */
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
      .prepare("SELECT * FROM subagents WHERE taskId=? ORDER BY rowid")
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
    if (
      JSON.stringify(context).length > 2_000_000 ||
      (report?.length ?? 0) > 32_000
    ) {
      throw new Error("subagent 上下文或报告超过保存限制。");
    }

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
      ids.length > 4 ||
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
    if (
      !requestId ||
      requestId.length > 128 ||
      !question.trim() ||
      question.length > 1_000
    ) {
      throw new Error("subagent 问题或请求 ID 超过安全边界。");
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
    if (!payload || payload.length > 2_000_000) {
      throw new Error("subagent 请求结果过大或为空。");
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
    this.selectSession(sessionId);
    const createdAt = new Date().toISOString();
    const id = this.nextEventId;
    this.db
      .prepare(
        "INSERT INTO events(id,sessionId,taskId,type,data,createdAt) VALUES(?,?,?,?,?,?)",
      )
      .run(id, sessionId, taskId, type, JSON.stringify(data), createdAt);
    this.nextEventId++;

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

  events(sessionId: string, after = 0) {
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return [];
    }

    return shard.db
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
      : this.runWorker<Event[]>({
          operation: "events",
          file: this.selectSession(sessionId).file,
          sessionId,
          after,
        });
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

  /** 新任务读取活动上下文时在线程外 JSON.parse；空或短上下文直接读取以避免无意义的 Worker 启动。 */
  async contextAsync(id: string): Promise<any[]> {
    return this.serializedSize("context", id) < 64 * 1024
      ? this.context(id)
      : this.runWorker<any[]>({
          operation: "context",
          file: this.selectSession(id).file,
          sessionId: id,
        });
  }

  /** 仅在显式替换活动历史（例如测试初始化）时建立基线；正常模型/工具反馈使用 appendContext。 */
  saveContext(id: string, items: any[]) {
    this.selectSession(id);
    this.db.exec("SAVEPOINT replace_context");
    try {
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
        "SELECT data FROM context_snapshots WHERE sessionId=? ORDER BY rowid DESC LIMIT 1",
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

  /** 压缩链路读取父快照时在线程外解析完整原文；不存在或短快照无需启动 Worker。 */
  async latestContextSnapshotAsync(sessionId: string) {
    return this.serializedSize("latestSnapshot", sessionId) < 64 * 1024
      ? this.latestContextSnapshot(sessionId)
      : this.runWorker<ContextSnapshot | undefined>({
          operation: "latestSnapshot",
          file: this.selectSession(sessionId).file,
          sessionId,
        });
  }

  /** 历史回读和连续压缩按会话读取快照；大 source 不在 API 主线程 JSON.parse。 */
  async contextSnapshotAsync(sessionId: string, id: string) {
    return this.serializedSize("snapshot", sessionId, id) < 64 * 1024
      ? this.contextSnapshot(sessionId, id)
      : this.runWorker<ContextSnapshot | undefined>({
          operation: "snapshot",
          file: this.selectSession(sessionId).file,
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
    const shard = this.sessionShard(sessionId);
    if (!shard) {
      return 0;
    }

    if (source === "events") {
      const row = shard.db
        .prepare(
          "SELECT COALESCE(SUM(length(data)), 0) AS size FROM events WHERE sessionId=? AND id>?",
        )
        .get(sessionId, after) as { size: number };

      return row.size;
    }

    if (source === "context") {
      const row = shard.db
        .prepare(
          "SELECT COALESCE(SUM(length(items)),0) AS size FROM context_chunks WHERE sessionId=?",
        )
        .get(sessionId) as { size: number };

      return row.size;
    }

    const row = shard.db
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

    await this.runWorker<void>({
      operation: "compact",
      file: this.selectSession(sessionId).file,
      sessionId,
      snapshot,
      input,
    });
  }

  /** Worker 只接受固定 operation 和已定位的会话分片路径，不能成为通用 SQL 或命令执行入口。 */
  private async runWorker<T>(request: {
    operation: "context" | "events" | "latestSnapshot" | "snapshot" | "compact";
    file: string;
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
      worker.postMessage(request);
    });
  }

  close() {
    this.shards.close();
  }
}
