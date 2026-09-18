/**
 * 在 ToolRunner 与未来平台 SandboxRuntime 之间提供可信的命令分流和安全失败边界。
 * ToolRunner 在完成既有参数、路径、Git、提权及审批检查后调用 Broker；Broker 只接收固定的命令描述，
 * 不能代表 runtime 打开任意宿主路径或执行新的宿主命令。
 *
 * 1. status 返回启动时可公开的实际模式：关闭时为 non-isolated，启用且未验证后端时为 unknown。
 * 2. executeCommand 记录无敏感内容的策略、provision、执行和收集阶段，并在关闭时调用传入的既有宿主执行器。
 * 3. 启用时先调用 runtime.selfCheck，只有成功后才允许 runtime.execute；缺失、失败或未知状态都抛出安全失败。
 * 4. record 将阶段交给任务事件和 tracing；它只传模式、平台、等级和受限原因，不传命令或工作区路径。
 *
 * 当前 S0 不注册平台 runtime，因此启用开关会拒绝 run_command 而不会降级到宿主权限。S1 及后续阶段
 * 可注入经过真实平台验证的 runtime，并保持本接口的默认拒绝行为。
 */

import type {
  SandboxCommand,
  SandboxConfiguration,
  SandboxRuntime,
  SandboxStage,
  SandboxStatus,
} from "./types.js";
import { SandboxUnavailableError } from "./types.js";

export class SandboxBroker {
  private latestStatus: SandboxStatus;

  constructor(
    private configuration: SandboxConfiguration,
    private runtime?: SandboxRuntime,
  ) {
    this.latestStatus = configuration.initialStatus;
  }

  get status() {
    return this.latestStatus;
  }

  private record(
    stage: SandboxStage,
    onStage: (stage: SandboxStage, status: SandboxStatus) => void,
    status = this.latestStatus,
  ) {
    onStage(stage, status);
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

    if (!this.configuration.enabled) {
      this.record("executing", onStage);
      const result = await executeHost();
      this.record("collecting", onStage);
      this.record("completed", onStage);

      return { result, status: this.latestStatus };
    }

    this.record("provisioning", onStage);
    if (!this.runtime) {
      this.record("failed", onStage);
      throw new SandboxUnavailableError(
        this.latestStatus.reason ?? "后端不可用。",
      );
    }

    try {
      const checked = await this.runtime.selfCheck(command.signal);
      command.signal.throwIfAborted();
      this.latestStatus = {
        enabled: true,
        mode: "sandboxed",
        platform: process.platform,
        level: checked.level,
      };
      this.record("executing", onStage);
      const result = await this.runtime.execute(command);
      this.record("collecting", onStage);
      this.record("completed", onStage);

      return { result, status: this.latestStatus };
    } catch (error) {
      if (command.signal.aborted) {
        throw error;
      }

      const detail =
        error instanceof Error ? error.message : "后端未提供详细错误。";
      this.latestStatus = {
        enabled: true,
        mode: "unknown",
        platform: process.platform,
        level: null,
        reason: `平台 sandbox 自检或执行失败：${detail.slice(0, 300)}`,
      };
      this.record("failed", onStage);
      throw new SandboxUnavailableError(
        this.latestStatus.reason ?? "后端未提供失败原因。",
      );
    }
  }
}
