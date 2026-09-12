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
