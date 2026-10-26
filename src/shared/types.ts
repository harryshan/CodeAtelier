/**
 * 定义 server、agent 和 web 共用的数据类型，使 API 两端使用一致的字段。
 * 这里不依赖后端的文件或数据库实现。
 *
 * 1. TaskStatus 和 TitleState 列出任务及自动标题状态，Session 和 Task 描述会话及其中的任务；Task 的 subagentsEnabled 是任务创建时固定的选择，createdAt、startedAt 与 finishedAt 区分排队、实际运行和结束时间。
 * 2. SubagentRecord 描述研究子任务的状态、检查点与报告；Event 表示有顺序的历史条目，Approval 表示待审批操作。
 * 3. WorktreeInfo 是 API 从清单补充的模式（Riftri/Worktree）、来源/创建基线和后端诊断；旧清单默认 Worktree，不根据 backend 推断模式。Session.workspace 始终是实际执行路径；Settings 描述公开配置，Snapshot 汇总会话、事件、任务和审批。
 * 4. LocalOverlayInfo 独立描述私有视图与选定源码发布状态，不携带控制路径或候选命令；LocalOverlayCreation 仅报告入口前提，不证明驱动/Runtime 已可用。
 *    resolution 仅记录冲突继续的父会话、文件及新视图内参考目录；paths 为整组选择，path 保留首文件兼容，不把历史内容当成已应用源码。
 *    publicationRecovery 仅表示会话存在待核查的批次，真实来源执行排空仍由原生租约验证。
 *    interruptedReview 仅提供中断参考检查入口，非排空证明；resolution.state 保留可能部分写入标记。
 *
 * 类型不会在运行时校验请求，相关检查仍由 API 和 Config 完成。公开 Settings 不包含密钥。
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TitleState =
  "pending" | "generating" | "completed" | "failed" | "manual";

export interface WorktreeInfo {
  id: string;
  mode?: "riftri" | "worktree";
  projectWorkspace?: string;
  baseRef?: string;
  baseCommit?: string;
  backend?: "git" | "riftri-reflink" | "riftri-apfs" | "riftri-winfsp";
  fallbackReason?: string;
  clonedFiles?: number;
  state: "preparing" | "ready" | "failed" | "unavailable";
}

export interface Session {
  id: string;
  title: string;
  workspace: string;
  /** API 从宿主清单补充；workspace 始终是实际执行目录。 */
  worktree?: WorktreeInfo;
  localOverlay?: LocalOverlayInfo;
  createdAt: string;
  updatedAt: string;
  titleState: TitleState;
}

/** API 从 Local 清单补充，独立于 Git 模式；不传控制目录、基线正文或候选命令。 */
export interface LocalOverlayInfo {
  id: string;
  projectWorkspace?: string;
  state: "preparing" | "ready" | "active" | "failed" | "unavailable";
  epoch?: number;
  publicationRecovery?: boolean;
  privateRefreshRecovery?: boolean;
  refreshedTaskId?: string;
  interruptedReview?: boolean;
  resolution?: {
    sessionId: string;
    path: string;
    paths?: string[];
    directory: string;
    state?: "interrupted";
  };
  publication?: {
    state: "selected" | "publishing" | "published" | "rejected" | "retained";
    files?: number;
    reason?: string;
  };
}

export interface LocalOverlayCreation {
  enabled: boolean;
  reason?: string;
}

export interface Task {
  id: string;
  sessionId: string;
  status: TaskStatus;
  subagentsEnabled: boolean;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string;
}

export type SubagentStatus =
  | "planned"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentRecord {
  taskId: string;
  id: string;
  status: SubagentStatus;
  plan: {
    id: string;
    // 历史自由文本角色保持可读；新计划由 subtaskSchema 限定内置角色。
    role: string;
    changes?: string;
    objective: string;
    scope: string[];
    dependsOn: string[];
    deliverable: string;
  };
  report: string | null;
  context: unknown[];
  consumed: boolean;
  updatedAt: string;
}

export interface Event {
  bodyDeferred?: boolean;
  bodyBytes?: number;
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
  reviewReason?: string;
}

export interface SandboxStatus {
  enabled: boolean;
  requested: boolean;
  applied: boolean;
  mode: "non-isolated" | "sandboxed" | "host-process-fallback" | "unknown";
  platform: string;
  level: string | null;
  reason?: string;
  failureCategory?:
    | "runtime_missing"
    | "workspace_preflight"
    | "runtime_self_check"
    | "runtime_execution";
}

export interface Settings {
  protocol?: import("../providers/protocol.js").ModelProtocol;
  auxiliaryProtocol?: import("../providers/protocol.js").ModelProtocol;
  auxiliaryBaseUrl?: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  auxiliaryModel?: string;
  auxiliaryReasoningEffort?: "none" | "low" | "medium" | "high";
  maxSteps: number;
  maxConcurrentTasks: number;
  commandTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  maxOutputTokens?: number;
  maxContextTokens: number;
  contextChars: number;
  outputChars: number;
  logLevel: string;
}

export interface Snapshot {
  history?: {
    highWater: number;
    cursor: number;
    hasOlder: boolean;
    hasNewer: boolean;
  };
  statisticsProjection?: {
    base: import("./session-statistics.js").SessionStatistics;
    runningStarts: number[];
  };
  session: Session;
  events: Event[];
  tasks: Task[];
  approvals: Approval[];
}
