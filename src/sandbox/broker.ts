/**
 * 在 ToolRunner 与平台 SandboxRuntime 之间提供可信的命令分流、显式宿主 fallback 和执行后失败边界。
 * ToolRunner 在完成既有参数、路径、Git、提权及审批检查后调用 Broker；Broker 只接收固定的命令描述，
 * 不能代表 runtime 打开任意宿主路径或执行新的宿主命令。
 *
 * 1. status 只返回启动配置；每任务/instance 的真实模式由 statusFor 与 executeCommand 结果隔离保存，避免并发串扰。
 * 2. executeCommand 记录策略、preflight、fallback、执行和收集阶段；Sandbox 关闭时完全沿用既有宿主执行器。
 * 3. 启用时先建立 WorkspaceView 并调用 runtime.selfCheck；缺后端或启动前检查失败时按任务固定转为宿主执行。
 * 4. runtime.execute 开始后的异常绝不自动重放到宿主；unknown/orphaned 会冻结 generation 并调用原生整代排空。
 * 5. 共享 ACL 安装由 provision waiter 串行可见，释放由 prepare/native revoke/commit 两阶段协议保护账本。
 * 6. 独立 Sandbox logger 只接收类别、阶段、关联 ID、耗时和结果，不记录命令、路径、SID、端口或输出。
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
  SandboxPreparedAccess,
} from "./types.js";
import { SandboxUnavailableError } from "./types.js";
import { WorkspaceView } from "./workspace-view.js";
import { buildAccessManifest } from "./access-manifest.js";
import { AccountGenerationRegistry } from "./account-generation.js";
import type { AccessManifest } from "./supervisor-protocol.js";

export class SandboxBroker {
  private fallbackTasks = new Map<string, SandboxStatus>();
  private executionStatuses = new Map<string, SandboxStatus>();
  private executionTasks = new Map<string, string>();
  private accountGeneration?: AccountGenerationRegistry;
  private releaseQueue = Promise.resolve();
  private generationDrain?: Promise<void>;

  constructor(
    private configuration: SandboxConfiguration,
    private runtime?: SandboxRuntime,
    private log?: Logger,
  ) {}

  get status() {
    return this.configuration.initialStatus;
  }

  statusFor(taskId: string, executionInstanceId?: string) {
    return (
      (executionInstanceId
        ? this.executionStatuses.get(executionInstanceId)
        : undefined) ??
      this.fallbackTasks.get(taskId) ??
      this.configuration.initialStatus
    );
  }

  accountGenerationSnapshot() {
    return this.accountGeneration?.snapshot();
  }

  /** Engine 在任务结束时释放按任务固定的 fallback 决策，避免长期服务积累已完成 taskId。 */
  releaseTask(taskId: string) {
    this.fallbackTasks.delete(taskId);
    for (const [executionInstanceId, executionTaskId] of this.executionTasks) {
      if (executionTaskId === taskId) {
        this.executionTasks.delete(executionInstanceId);
        this.executionStatuses.delete(executionInstanceId);
      }
    }
  }

  async shutdown() {
    await this.runtime?.shutdown?.();
  }

  /** 服务监听前主动排空上次进程遗留；失败不阻止服务启动，但后续 Sandbox self-check 会安全 fallback。 */
  async recoverAtStartup() {
    if (!this.configuration.enabled || !this.runtime?.recoverStartup) {
      return;
    }

    try {
      await this.runtime.recoverStartup(AbortSignal.timeout(30_000));
      this.log?.info({
        event: "sandbox.account_generation.startup_recovery_completed",
        module: "sandbox",
      });
    } catch (error) {
      this.log?.error({
        event: "sandbox.account_generation.startup_recovery_failed",
        module: "sandbox",
        ...this.errorMetadata(error),
      });
    }
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
      processCreationTime100ns: record.processCreationTime100ns,
      requested: record.sandboxRequested,
      applied: record.sandboxApplied,
      failureCategory: record.failureCategory,
      sideEffectsPossible: record.sideEffectsPossible,
    });
  }

  private record(
    stage: SandboxStage,
    onStage: (stage: SandboxStage, status: SandboxStatus) => void,
    status = this.configuration.initialStatus,
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

  private rootsForGrantRevocation(
    manifest: AccessManifest,
    identities: string[],
  ) {
    const requested = new Set(identities);
    const roots = [
      ...manifest.readRoots.map((root) => ({
        ...root,
        objectType: "directory" as const,
      })),
      ...manifest.writeRoots.map((root) => ({
        ...root,
        objectType: "directory" as const,
      })),
      ...manifest.gitConfigFiles.map((root) => ({
        ...root,
        objectType: "file" as const,
      })),
    ].filter((root) => requested.delete(root.objectIdentityDigest));

    if (requested.size > 0) {
      throw new Error("AccessManifest 无法解析待撤销的共享授权。");
    }

    return roots;
  }

  private async releaseAccess(
    command: SandboxCommand,
    manifest: AccessManifest,
    acquired: NonNullable<ReturnType<AccountGenerationRegistry["acquire"]>>,
  ) {
    if (!this.accountGeneration) {
      return;
    }

    const priorRelease = this.releaseQueue;
    let finishRelease!: () => void;
    this.releaseQueue = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    await priorRelease;

    let release:
      | ReturnType<AccountGenerationRegistry["prepareReleaseWithManifest"]>
      | undefined;
    try {
      release = this.accountGeneration.prepareReleaseWithManifest(
        command.executionInstanceId,
        acquired.lease.epoch,
        manifest,
      );
      const roots = this.rootsForGrantRevocation(
        manifest,
        release.revoke.map((grant) => grant.objectIdentityDigest),
      );
      if (roots.length > 0) {
        if (!this.runtime?.revokeAccess) {
          throw new Error("平台 Runtime 未实现共享 ACL 撤销。");
        }

        await this.runtime.revokeAccess(roots, AbortSignal.timeout(20_000));
      }

      this.accountGeneration.commitRelease(release.releaseId, manifest);
      this.log?.info({
        event: "sandbox.root_revoke.completed",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        grantRevokeCount: release.revoke.length,
      });
    } catch (error) {
      if (release) {
        this.accountGeneration.abortRelease(release.releaseId);
      }

      this.accountGeneration.quarantine("acl_cleanup");
      throw error;
    } finally {
      finishRelease();
    }
  }

  private cleanupFailure(error: unknown) {
    return (
      error !== null &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "WINDOWS_SANDBOX_CLEANUP_UNKNOWN"
    );
  }

  private async quarantineGeneration(
    command: SandboxCommand,
    category: "process_unknown" | "acl_cleanup" | "proxy_cleanup",
  ) {
    const affected = this.accountGeneration?.quarantine(category) ?? [];
    this.log?.error({
      event: "sandbox.account_generation.quarantined",
      module: "sandbox",
      sessionId: command.sessionId,
      taskId: command.taskId,
      executionInstanceId: command.executionInstanceId,
      affectedInstanceCount: affected.length,
      category,
    });

    if (!this.runtime?.drainGeneration) {
      this.log?.error({
        event: "sandbox.account_generation.drain_failed",
        module: "sandbox",
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        category: "runtime_missing",
      });

      return false;
    }

    this.generationDrain ??= this.runtime
      .drainGeneration(AbortSignal.timeout(30_000), {
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
      })
      .finally(() => {
        this.generationDrain = undefined;
      });
    try {
      await this.generationDrain;
      this.log?.warn({
        event: "sandbox.account_generation.drain_completed",
        module: "sandbox",
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        affectedInstanceCount: affected.length,
      });

      return true;
    } catch (error) {
      this.log?.error({
        event: "sandbox.account_generation.drain_failed",
        module: "sandbox",
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        ...this.errorMetadata(error),
      });

      return false;
    }
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
    this.fallbackTasks.set(command.taskId, status);
    this.executionStatuses.set(command.executionInstanceId, status);
    this.executionTasks.set(command.executionInstanceId, command.taskId);
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
    const initialStatus = this.statusFor(
      command.taskId,
      command.executionInstanceId,
    );
    this.executionTasks.set(command.executionInstanceId, command.taskId);
    this.executionStatuses.set(command.executionInstanceId, initialStatus);
    this.record("policy_resolved", onStage, initialStatus);
    this.log?.debug({
      event: "sandbox.command_policy_resolved",
      module: "sandbox",
      sessionId: command.sessionId,
      taskId: command.taskId,
      executionInstanceId: command.executionInstanceId,
      requested: this.configuration.enabled,
    });

    if (!this.configuration.enabled) {
      this.record("executing", onStage, initialStatus);
      const result = await executeHost();
      this.record("collecting", onStage, initialStatus);
      this.record("completed", onStage, initialStatus);

      return { result, status: initialStatus };
    }

    const priorFallback = this.fallbackTasks.get(command.taskId);
    if (priorFallback) {
      this.executionStatuses.set(command.executionInstanceId, priorFallback);
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

    this.record("provisioning", onStage, initialStatus);
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
    let prepared: SandboxPreparedAccess | undefined;
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

      prepared = await this.runtime.prepareAccess?.(command, workspace);
      manifest = await buildAccessManifest({
        workspaceRoot: workspace.root,
        readOnlyRoots: prepared?.readOnlyRoots,
        readWriteRoots: prepared?.readWriteRoots,
        gitConfigFiles: prepared?.gitConfigFiles,
      });
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
        kind: command.kind ?? "agent-runtime",
        taskId: command.taskId,
        accessManifest: manifest,
      });
      await acquired?.waitForSharedProvision();
    } catch (error) {
      if (acquired && this.accountGeneration) {
        try {
          this.accountGeneration.rollbackAcquire(
            command.executionInstanceId,
            acquired.lease.epoch,
            manifest!,
          );
        } catch {
          await this.quarantineGeneration(command, "acl_cleanup");
        }
      }

      await prepared?.cleanup().catch(() => {});
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

    const sandboxedStatus: SandboxStatus = {
      enabled: true,
      requested: true,
      applied: true,
      mode: "sandboxed",
      platform: process.platform,
      level: checked.level,
    };
    this.executionStatuses.set(command.executionInstanceId, sandboxedStatus);
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
      this.record("executing", onStage, sandboxedStatus);
      this.log?.info({
        event: "sandbox.runtime_execute_started",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        level: checked.level,
      });
      let provisionConfirmed = false;
      const runtimeCommand: SandboxCommand = {
        ...command,
        onAccessProvisioned: () => {
          if (provisionConfirmed) {
            return;
          }

          provisionConfirmed = true;
          if (acquired) {
            this.accountGeneration?.markProvisioned(
              command.executionInstanceId,
              acquired.lease.epoch,
            );
          }
        },
      };
      const result = await this.runtime.execute(runtimeCommand, workspace, {
        manifest,
        leaseEpoch: acquired?.lease.epoch,
        installObjectIdentityDigests:
          acquired?.install.map((grant) => grant.objectIdentityDigest) ?? [],
        privateDirectory: prepared?.privateDirectory,
        gitGlobalConfigPath: prepared?.gitGlobalConfigPath,
      });
      if (acquired) {
        if (!provisionConfirmed && acquired.install.length > 0) {
          throw new Error("原生 Runtime 未确认共享 ACL grant 已完成安装。");
        }

        await this.releaseAccess(command, manifest, acquired);
      }

      await prepared?.cleanup();

      this.record("collecting", onStage, sandboxedStatus);
      this.record("completed", onStage, sandboxedStatus);
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

      return { result, status: sandboxedStatus };
    } catch (error) {
      let failure = error;
      if (acquired) {
        try {
          this.accountGeneration?.markProvisionFailed(
            command.executionInstanceId,
            acquired.lease.epoch,
          );
        } catch {
          // 已完成 provision 或账本已 quarantine 时无需覆盖原始失败。
        }
      }

      if (command.signal.aborted && !this.cleanupFailure(failure)) {
        if (acquired) {
          try {
            await this.releaseAccess(command, manifest, acquired);
          } catch (cleanupError) {
            failure = cleanupError;
          }
        }

        if (failure === error) {
          try {
            await prepared?.cleanup();
          } catch (cleanupError) {
            failure = cleanupError;
          }
        }

        if (failure === error) {
          throw error;
        }
      }

      const unknownStatus: SandboxStatus = {
        enabled: true,
        requested: true,
        applied: false,
        mode: "unknown",
        platform: process.platform,
        level: null,
        reason: "平台 Sandbox 执行失败且结果可能未知；当前操作未自动重放。",
        failureCategory: "runtime_execution",
      };
      this.executionStatuses.set(command.executionInstanceId, unknownStatus);
      const cleanupUnknown = this.cleanupFailure(failure) || failure !== error;
      const drained = await this.quarantineGeneration(
        command,
        cleanupUnknown ? "acl_cleanup" : "process_unknown",
      );
      if (drained) {
        await prepared?.cleanup().catch(() => {});
      }

      this.record("failed", onStage, unknownStatus);
      this.log?.error({
        event: "sandbox.runtime_execute_failed",
        module: "sandbox",
        sessionId: command.sessionId,
        taskId: command.taskId,
        executionInstanceId: command.executionInstanceId,
        ...this.errorMetadata(failure),
      });
      throw new SandboxUnavailableError(
        unknownStatus.reason ?? "后端未提供失败原因。",
      );
    }
  }
}
