import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Session, Task, TaskStatus, Event } from "../shared/types.js";
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id),status TEXT NOT NULL,createdAt TEXT NOT NULL,error TEXT);
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT NOT NULL REFERENCES sessions(id),taskId TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,createdAt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS context(sessionId TEXT PRIMARY KEY REFERENCES sessions(id),items TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_session ON events(sessionId,id);
 PRAGMA user_version=1;`);
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted',error='服务已重启，任务中断；未重放命令。' WHERE status IN ('running','waiting')",
      )
      .run();
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
      .prepare("SELECT * FROM tasks WHERE sessionId=? ORDER BY createdAt")
      .all(sessionId) as unknown as Task[];
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
  close() {
    this.db.close();
  }
}
