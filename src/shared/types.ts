/**
 * 定义 server、agent 和 web 共用的数据类型，使 API 两端使用一致的字段。
 * 这里不依赖后端的文件或数据库实现。
 *
 * 1. TaskStatus 和 TitleState 列出任务及自动标题状态，Session 和 Task 描述会话及其中的任务。
 * 2. Event 表示有顺序的历史条目，Approval 表示待审批操作。
 * 3. Settings 描述公开配置，Snapshot 汇总页面需要的会话、事件、任务和审批。
 *
 * 类型不会在运行时校验请求，相关检查仍由 API 和 Config 完成。公开 Settings 不包含密钥。
 */

export type TaskStatus =
  "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";

export type TitleState =
  "pending" | "generating" | "completed" | "failed" | "manual";

export interface Session {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  titleState: TitleState;
}

export interface Task {
  id: string;
  sessionId: string;
  status: TaskStatus;
  createdAt: string;
  error?: string;
}

export interface Event {
  id: number;
  sessionId: string;
  taskId: string;
  type: string;
  data: any;
  createdAt: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  taskId: string;
  tool: string;
  description: string;
  repeatable: boolean;
}

export interface Settings {
  baseUrl: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  auxiliaryModel?: string;
  auxiliaryReasoningEffort?: "low" | "medium" | "high";
  maxSteps: number;
  commandTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  maxOutputTokens?: number;
  contextChars: number;
  outputChars: number;
  logLevel: string;
}

export interface Snapshot {
  session: Session;
  events: Event[];
  tasks: Task[];
  approvals: Approval[];
}
