/**
 * 用 SQLite 保存会话、任务、事件和模型上下文，供 Engine、HTTP 接口和 ContextManager 使用。
 *
 * 1. 构造器初始化数据库，把重启前未完成的任务标为 interrupted；transaction 包装提交和回滚。
 * 2. list/get/create 读写会话；标题状态的领取、完成或失败保证首条 prompt 只生成一次标题。
 * 3. tasks/task/createTask/status 读写任务状态；event/events 保存和分页读取事件。
 * 4. context/saveContext 读写当前模型历史；快照按会话查询，compactContext 原子替换活动上下文。
 * 5. close 由应用退出流程调用，关闭数据库连接。
 *
 * 事务只能回滚数据库，不能撤销文件修改或命令执行。恢复需要的未知状态和原始记录必须保留。
 */

import type { ContextSnapshot } from "../context/types.js";
import { SCHEMA_SQL } from "./schema.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Session, Task, TaskStatus, Event } from "../shared/types.js";

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    // 进程重启只能确认任务已中断，不能断言先前的命令是否执行成功。
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted',error='服务已重启，任务中断；未重放命令。' WHERE status IN ('running','waiting')",
      )
      .run();
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

  task(id: string) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(id) as unknown as Task | undefined;
  }

  createTask(sessionId: string) {
    const task = {
      id: randomUUID(),
      sessionId,
      status: "running" as TaskStatus,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        "INSERT INTO tasks(id,sessionId,status,createdAt) VALUES(?,?,?,?)",
      )
      .run(task.id, sessionId, task.status, task.createdAt);

    return task;
  }

  status(id: string, status: TaskStatus, error?: string) {
    this.db
      .prepare("UPDATE tasks SET status=?,error=? WHERE id=?")
      .run(status, error || null, id);
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

  context(id: string): any[] {
    const row = this.db
      .prepare("SELECT items FROM context WHERE sessionId=?")
      .get(id);

    return row ? JSON.parse(String(row.items)) : [];
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

  /** 快照和活动上下文一起提交；失败后继续使用原来的完整输入。 */
  compactContext(snapshot: ContextSnapshot, input: any[]) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO context_snapshots(id,sessionId,data) VALUES(?,?,?)",
        )
        .run(snapshot.id, snapshot.sessionId, JSON.stringify(snapshot));
      this.saveContext(snapshot.sessionId, input);
    });
  }

  close() {
    this.db.close();
  }
}
