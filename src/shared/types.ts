/**
 * 文件作用：定义前后端共享的会话和任务数据契约。
 *
 * 模块协作与输入输出：
 * 被 server、agent 和 web 共同导入，表达 API 传输的领域数据，不依赖后端文件或数据库实现。
 *
 * 代码结构与执行顺序：
 * 1. TaskStatus 定义任务生命周期，Session 和 Task 描述会话归属及执行记录。
 * 2. Event 描述有序历史条目，Approval 描述待批准操作及是否可复用。
 * 3. Settings 声明可传输配置，Snapshot 聚合页面需要的会话、事件、任务及审批。
 *
 * 关键约束：
 * 类型本身不验证不可信请求；API 和 Config 的运行时校验必须与这里同步，密钥不属于公开 Settings。
 */

export type TaskStatus =
  "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";

export interface Session {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
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
