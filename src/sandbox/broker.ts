/**
 * 在 ToolRunner 与平台 SandboxRuntime 之间提供可信的命令分流、显式宿主 fallback 和执行后失败边界。
 * ToolRunner 在完成既有参数、路径、Git、提权及审批检查后调用 Broker；Broker 只接收固定的命令描述，
 * 不能代表 runtime 打开任意宿主路径或执行新的宿主命令。
 *
 * 1. status 返回最近一次执行的真实模式；requested/applied 防止宿主 fallback 被误报为已隔离。
 * 2. executeCommand 记录策略、preflight、fallback、执行和收集阶段；Sandbox 关闭时完全沿用既有宿主执行器。
 * 3. 启用时先建立 WorkspaceView 并调用 runtime.selfCheck；缺后端或启动前检查失败时按任务固定转为宿主执行。
 * 4. runtime.execute 开始后的异常绝不自动重放到宿主，避免重复副作用；状态改为 unknown 并交给恢复流程。
 * 5. 独立 Sandbox logger 只接收类别、阶段、关联 ID、耗时和结果，不记录命令、路径、SID、端口或输出。
 *
 * WorkspaceView 仍是历史 WSL2 Runtime 的契约；目标 Windows Runtime 将以 AccessManifest 取代它。fallback
 * 只保证功能继续，不具备 Sandbox 的文件、进程和网络隔离能力。
 */

import type { Logger } from "pino";
import type {
  SandboxCommand,
  SandboxConfiguration,
  SandboxRuntime,
  SandboxFailureCategory,
  ExecutionInstanceRecord,
  SandboxStage,
  SandboxStatus,
} from "./types.js";
import { SandboxUnavailableError } from "./types.js";
import { WorkspaceView } from "./workspace-view.js";
import { buildAccessManifest } from "./access-manifest.js";
import { AccountGenerationRegistry } from "./account-generation.js";

export class SandboxBroker {
  private latestStatus: SandboxStatus;
  private fallbackTasks = new Map<string, SandboxStatus>();
  private accountGeneration?: AccountGenerationRegistry;

  constructor(
    private configuration: SandboxConfiguration,
    private runtime?: SandboxRuntime,
    private log?: Logger,
  ) {
    this.latestStatus = configuration.initialStatus;
  }

  get status() {
    return this.latestStatus;
  }

  /** Engine 在任务结束时释放按任务固定的 fallback 决策，避免长期服务积累已完成 taskId。 */
  releaseTask(taskId: string) {
    this.fallbackTasks.delete(taskId);
  }

  /** ToolRunner 持久化同一份安全摘要时，专用日志同步留下可按 instance 追踪的状态。 */
  recordExecutionInstance(record: ExecutionInstanceRecord) {
    this.log?.info({
      event: "sandbox.execution_instance",
      module: "sandbox",
      executionInstanceId: record.executionInstanceId,
      kind: record.kind,
      mode: record.mode,
      state: record.state,
      pid: record.pid,
      pidKind: record.pidKind,
      requested: record.sandboxRequested,
      applied: record.sandboxApplied,
      failureCategory: record.failureCategory,
      sideEffectsPossible: record.sideEffectsPossible,
    });
  }

  private record(
    stage: SandboxStage,
    onStage: (stage: SandboxStage, status: SandboxStatus) => void,
    status = this.latestStatus,
  ) {
    onStage(stage, status);
  }

  private diagnosticReason(category: SandboxFailureCategory) {
    const prefix: Record<SandboxFailureCategory, string> = {
      runtime_missing: "当前平台 Sandbox Runtime 不可用",
      workspace_preflight: "Sandbox 工作区预检失败",
      runtime_self_check: "Sandbox Runtime 自检失败",
      runtime_execution: "Sandbox Runtime 执行失败，结果可能未知",
    };

    return `${prefix[category]}；已自动改用宿主权限。`;
  }

  private errorMetadata(error: unknown) {
    const source = error && typeof error === "object" ? error : undefined;
    const code = source ? Reflect.get(source, "code") : undefined;

    return {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode:
        typeof code === "string" || typeof code === "number"
          ? String(code).slice(0, 80)
          : undefined,
    };
  }

  private async executeFallback(
    command: SandboxCommand,
    category: Exclude<SandboxFailureCategory, "runtime_execution">,
    executeHost: () => Promise<{
      output: string;
      exitCode: number | null;
      truncated: boolean;
    }>,
    onStage: (stage: SandboxStage, status: SandboxStatus) => void,
  ) {
    const status: SandboxStatus = {
      enabled: true,
      requested: true,
      applied: false,
      mode: "host-process-fallback",
      platform: process.platform,
      level: null,
      reason: this.diagnosticReason(category),
      failureCategory: category,
    };
    this.latestStatus = status;
    this.fallbackTasks.set(command.taskId, status);
    this.log?.warn({
      event: "sandbox.fallback_selected",
      module: "sandbox",
      sessionId: command.sessionId,
      taskId: command.taskId,
      executionInstanceId: command.executionInstanceId,
      category,
      requested: true,
      applied: false,
    });
    this.record("fallback_selected", onStage, status);
    this.record("executing", onStage, status);

    try {
      const result = await executeHost();
      this.record("collecting", onStage, status);
      this.record("completed", onStage, status);
      this.log?.info({
        event: "sandbox.fallback_completed",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        category,
        exitCode: result.exitCode,
        truncated: result.truncated,
      });

      return { result, status };
    } catch (hostError) {
      this.record("failed", onStage, status);
      this.log?.warn({
        event: "sandbox.fallback_failed",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        category,
        ...this.errorMetadata(hostError),
      });
      throw hostError;
    }
  }

  async executeCommand(
    command: SandboxCommand,
    executeHost: () => Promise<{
      output: string;
      exitCode: number | null;
      truncated: boolean;
    }>,
    onStage: (stage: SandboxStage, status: SandboxStatus) => void,
  ) {
    this.record("policy_resolved", onStage);
    this.log?.debug({
      event: "sandbox.command_policy_resolved",
      module: "sandbox",
      sessionId: command.sessionId,
      taskId: command.taskId,
      executionInstanceId: command.executionInstanceId,
      requested: this.configuration.enabled,
    });

    if (!this.configuration.enabled) {
      this.record("executing", onStage);
      const result = await executeHost();
      this.record("collecting", onStage);
      this.record("completed", onStage);

      return { result, status: this.latestStatus };
    }

    const priorFallback = this.fallbackTasks.get(command.taskId);
    if (priorFallback) {
      this.latestStatus = priorFallback;
      this.record("executing", onStage, priorFallback);
      const result = await executeHost();
      this.record("collecting", onStage, priorFallback);
      this.record("completed", onStage, priorFallback);

      return { result, status: priorFallback };
    }

    let workspace: ReturnType<WorkspaceView["descriptor"]>;

    try {
      workspace = (await WorkspaceView.open(command.cwd)).descriptor();
    } catch (error) {
      if (command.signal.aborted) {
        throw error;
      }

      return this.executeFallback(
        command,
        "workspace_preflight",
        executeHost,
        onStage,
      );
    }

    this.record("provisioning", onStage);
    if (!this.runtime) {
      return this.executeFallback(
        command,
        "runtime_missing",
        executeHost,
        onStage,
      );
    }

    let checked: Awaited<ReturnType<SandboxRuntime["selfCheck"]>>;
    let manifest: Awaited<ReturnType<typeof buildAccessManifest>>;
    let acquired: ReturnType<AccountGenerationRegistry["acquire"]> | undefined;
    try {
      this.log?.debug({
        event: "sandbox.self_check_started",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
      });
      checked = await this.runtime.selfCheck(command.signal, workspace);
      command.signal.throwIfAborted();

      if (checked.workspaceProtection !== "direct-path") {
        throw new Error("平台 runtime 未证明直接受保护路径防护。");
      }

      manifest = await buildAccessManifest({ workspaceRoot: workspace.root });
      command.signal.throwIfAborted();
      const generationDigest = checked.accountGenerationDigest;
      if (generationDigest) {
        if (
          this.accountGeneration &&
          this.accountGeneration.generationDigest !== generationDigest
        ) {
          this.accountGeneration.quarantine("identity_mismatch");
          throw new Error(
            "Sandbox account generation 在服务运行期间发生变化。",
          );
        }

        this.accountGeneration ??= new AccountGenerationRegistry(
          generationDigest,
          4,
        );
      }

      acquired = this.accountGeneration?.acquire({
        executionInstanceId: command.executionInstanceId,
        kind: "agent-runtime",
        taskId: command.taskId,
        accessManifest: manifest,
      });
    } catch (error) {
      if (command.signal.aborted) {
        throw error;
      }

      this.log?.warn({
        event: "sandbox.self_check_failed",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        ...this.errorMetadata(error),
      });

      return this.executeFallback(
        command,
        "runtime_self_check",
        executeHost,
        onStage,
      );
    }

    this.latestStatus = {
      enabled: true,
      requested: true,
      applied: true,
      mode: "sandboxed",
      platform: process.platform,
      level: checked.level,
    };
    this.log?.info({
      event: "sandbox.self_check_succeeded",
      module: "sandbox",
      sessionId: command.sessionId,
      taskId: command.taskId,
      executionInstanceId: command.executionInstanceId,
      level: checked.level,
    });

    if (acquired) {
      this.log?.info({
        event: "sandbox.instance_lease.acquired",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        leaseEpoch: acquired.lease.epoch,
        grantInstallCount: acquired.install.length,
      });
      this.log?.info({
        event: "sandbox.root_project.started",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        rootCount: manifest.writeRoots.length + manifest.readRoots.length,
      });
    }

    try {
      this.record("executing", onStage);
      this.log?.info({
        event: "sandbox.runtime_execute_started",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        level: checked.level,
      });
      const result = await this.runtime.execute(command, workspace);
      if (acquired && this.accountGeneration) {
        const released = this.accountGeneration.releaseWithManifest(
          command.executionInstanceId,
          acquired.lease.epoch,
          manifest,
        );
        this.log?.info({
          event: "sandbox.root_revoke.completed",
          module: "sandbox",
          sessionId: command.sessionId,
          taskId: command.taskId,
          executionInstanceId: command.executionInstanceId,
          grantRevokeCount: released.revoke.length,
        });
      }

      this.record("collecting", onStage);
      this.record("completed", onStage);
      this.log?.info({
        event: "sandbox.runtime_execute_completed",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        level: checked.level,
        exitCode: result.exitCode,
        truncated: result.truncated,
      });

      return { result, status: this.latestStatus };
    } catch (error) {
      if (command.signal.aborted) {
        if (acquired && this.accountGeneration) {
          try {
            this.accountGeneration.releaseWithManifest(
              command.executionInstanceId,
              acquired.lease.epoch,
              manifest,
            );
          } catch {
            this.accountGeneration.quarantine("ledger_inconsistent");
          }
        }

        throw error;
      }

      this.latestStatus = {
        enabled: true,
        requested: true,
        applied: false,
        mode: "unknown",
        platform: process.platform,
        level: null,
        reason: "平台 Sandbox 执行失败且结果可能未知；当前操作未自动重放。",
        failureCategory: "runtime_execution",
      };
      if (acquired && this.accountGeneration) {
        const affected = this.accountGeneration.quarantine("process_unknown");
        this.log?.error({
          event: "sandbox.account_generation.quarantined",
          module: "sandbox",
          sessionId: command.sessionId,
          taskId: command.taskId,
          executionInstanceId: command.executionInstanceId,
          affectedInstanceCount: affected.length,
          category: "process_unknown",
        });
      }

      this.record("failed", onStage);
      this.log?.error({
        event: "sandbox.runtime_execute_failed",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        ...this.errorMetadata(error),
      });
      throw new SandboxUnavailableError(
        this.latestStatus.reason ?? "后端未提供失败原因。",
      );
    }
  }
}
