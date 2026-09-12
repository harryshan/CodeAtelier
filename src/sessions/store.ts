/**
 * 文件作用：封装会话、任务、事件和上下文的 SQLite 持久化。
 *
 * 模块协作与输入输出：
 * 被 Engine、HTTP 路由和 ContextManager 使用，将会话运行状态保存在 Node SQLite 数据库中。
 *
 * 代码结构与执行顺序：
 * 1. 构造器初始化 schema，并把重启前的活动任务标记为 interrupted；transaction 提供提交/回滚边界。
 * 2. list/get/create 管理会话，tasks/task/createTask/status 管理任务与终态。
 * 3. event/events 保存并按游标读取历史，context/saveContext 管理发送模型的活动协议项。
 * 4. 快照查询按会话隔离；compactContext 在同一事务里插入来源快照并替换活动上下文。
 * 5. close 释放数据库连接，交由应用关闭流程调用。
 *
 * 关键约束：
 * 数据库事务不能回滚已执行的文件或进程副作用；不得删除恢复所需的未知状态与原始来源。
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
    // 进程重启只能确认任务已中断，不能断言先前的命令是否执行成功。
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted',error='服务已重启，任务中断；未重放命令。' WHERE status IN ('running','waiting')",
      )
      .run();
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

  create(workspace: string, title: string) {
    const date = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
      .run(id, title, workspace, date, date);

    return this.get(id)!;
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
