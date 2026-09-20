/**
 * 描述 SandboxBroker 与平台运行时之间的最小稳定契约，并向 Web UI 公开实际模式。
 * Config 在服务启动时创建 SandboxConfiguration；SandboxBroker 使用这些类型决定是否可执行命令，
 * ToolRunner 将结果与阶段事件保存到任务历史，浏览器只读取 SandboxStatus，不接触运行时实现。
 *
 * 1. SandboxMode 和 SandboxStatus 区分关闭时的宿主执行、已验证隔离、明确宿主 fallback 和未知状态。
 * 2. SandboxConfiguration 是只读环境开关结果，不属于可持久化的 settings.json 偏好。
 * 3. SandboxWorkspace 描述真实工作区根与直接受保护路径；Runtime 必须以文件系统边界落实它，不能只信任命令文本。
 * 4. SandboxCommand 与 SandboxRuntime 划定 Broker 可交给平台后端的固定命令请求；运行时不能反向请求任意宿主操作。
 * 5. SandboxStage 仅记录无敏感内容的生命周期事实，供事件与 tracing 关联。
 * 6. ExecutionInstanceRecord 持久化实际进程模式、PID 种类和恢复状态，不保存命令、路径或输出。
 *
 * 状态中的原因不得包含命令、工作区路径、外部文件内容或凭据。平台后端必须在 selfCheck 成功后才可返回
 * sandboxed；只有命令尚未启动且 provision 无遗留副作用时才可返回 host-process-fallback。
 */

export type SandboxMode =
  "non-isolated" | "sandboxed" | "host-process-fallback" | "unknown";

export type SandboxFailureCategory =
  | "runtime_missing"
  | "workspace_preflight"
  | "runtime_self_check"
  | "runtime_execution";

export interface SandboxStatus {
  enabled: boolean;
  requested: boolean;
  applied: boolean;
  mode: SandboxMode;
  platform: string;
  level: string | null;
  reason?: string;
  failureCategory?: SandboxFailureCategory;
}

export interface SandboxConfiguration {
  enabled: boolean;
  initialStatus: SandboxStatus;
}

export type SandboxStage =
  | "policy_resolved"
  | "provisioning"
  | "fallback_selected"
  | "executing"
  | "collecting"
  | "completed"
  | "failed";

export type ExecutionInstanceMode =
  | "host-process"
  | "legacy-wsl2-inspect"
  | "windows-sandbox-user"
  | "sandbox-runtime"
  | "unknown";

export type ExecutionInstanceState =
  "created" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export type ExecutionProcessKind =
  "host-process" | "runtime-launcher" | "runtime";

export interface ExecutionInstanceRecord {
  executionInstanceId: string;
  kind: "agent-runtime" | "push-runner";
  mode: ExecutionInstanceMode;
  state: ExecutionInstanceState;
  createdAt: string;
  updatedAt: string;
  sandboxRequested: boolean;
  sandboxApplied: boolean;
  pid?: number;
  pidKind?: ExecutionProcessKind;
  failureCategory?: SandboxFailureCategory;
  sideEffectsPossible?: boolean;
}

export interface SandboxWorkspace {
  root: string;
  protectedPaths: string[];
  protection: "direct-path";
}

export interface SandboxCommand {
  sessionId: string;
  taskId: string;
  executionInstanceId: string;
  command: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  outputLimit: number;
  onOutput: (text: string) => void;
  onProcessStarted: (pid: number, kind: ExecutionProcessKind) => void;
}

export interface SandboxRuntime {
  selfCheck(
    signal: AbortSignal,
    workspace: SandboxWorkspace,
  ): Promise<{ level: string; workspaceProtection: "direct-path" }>;
  execute(
    command: SandboxCommand,
    workspace: SandboxWorkspace,
  ): Promise<{
    output: string;
    exitCode: number | null;
    truncated: boolean;
  }>;
}

export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";

  constructor(reason: string) {
    super(`Sandbox 无法安全执行命令：${reason}`);
    this.name = "SandboxUnavailableError";
  }
}
