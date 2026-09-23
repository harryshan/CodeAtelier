/**
 * CodeAtelier 的任务执行入口，把模型请求、工具调用 DAG、审批和历史保存串起来。
 * HTTP 服务和手动评测都会创建 Engine；任务记录写入 Store，界面通过事件获知变化。
 *
 * 1. 构造器接好审批通知；snapshot 读取会话状态，emit 脱敏并保存事件。
 * 2. start 原子保存用户消息和任务级 subagent 选择为 queued；多 agent 尚未就绪时拒绝开启。调度器在全局并发上限内启动不同工作区的任务，并对相同真实工作区保持互斥。
 * 3. resume 继续最后一个可恢复任务；cancel 处理用户取消，close 处理服务关闭。
 * 4. 首条 prompt 先用辅助模型生成标题；run 再读取历史和项目规则，准备工具及上下文预算。
 * 5. model-loop 共用轮次、重试和停止控制，model-tool-batch 共用计划与成功判断；Engine 保留宿主事务、replay 与 tracing。为压缩提供 ToolRunner 的安全文件哈希探测；每轮记录上下文准备和请求计量、模型重试、实际模型请求和响应处理，再记录服务实报用量。完整响应保存后校验工具 DAG，节点先完成准备/审批，实际执行才取得有界 worker 槽。
 * 6. executeSandboxRunner 共用独立 Runner 状态与失败记录；本入口保留各自审批和命令构造。宿主模式的危险调用仍经过审批分流；Sandbox Runtime 已有能力内工具免审批，push 与扩展权限命令由 Broker 调用相同的低成本模型三级审批并持久化决定；扩展命令用一次性两阶段 IPC 授权把审批等待留在执行队列外。
 * 7. 可选子任务仅在任务标记启用时接入协调工具与独立 Worker lease；工具结果与模型反馈同事务提交。退出先停子线程再归档安全 trace、释放运行期记录并发出 task_end。
 *
 * 模型请求可以重试，但已经执行的工具不能跟着重跑。数据库回滚也撤销不了文件修改或
 * 已启动的命令，所以保存失败时必须停止任务，并留下足够的记录供后续恢复。
 */

import { auxiliarySettings } from "../config/auxiliary-model.js";
import type { Settings } from "../shared/types.js";
import { createBudget } from "../context/token-budget.js";
import type {
  ModelCapabilities,
  ModelUsage,
} from "../providers/model-metadata.js";
import {
  ContextManager,
  type ContextTrace,
} from "../context/context-manager.js";
import {
  historyDefinition,
  readContextHistoryAsync,
} from "../context/history.js";
import { prepareTaskContext } from "./context.js";
import { SubagentCoordinator } from "./subagent-coordinator.js";
import { SubagentLimits } from "./subagent-limits.js";
import {
  subagentToolDefinition,
  type SubagentAction,
} from "./subagent-contracts.js";
import { createInstructions } from "./instructions.js";
import { runModelLoop } from "./model-loop.js";
import {
  buildModelToolGraph,
  toolSucceeded,
} from "../tools/model-tool-batch.js";
import { executeSandboxRunner } from "../sandbox/execute-runner.js";
import { retryModel } from "../providers/retry.js";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { Logger } from "pino";
import { Store } from "../sessions/store.js";
import { generateConversationTitle } from "../sessions/title-generator.js";
import { Config } from "../config/config.js";
import { ApprovalManager } from "../permissions/approval-manager.js";
import {
  assessApproval,
  type ApprovalAssessment,
  type ApprovalSubject,
} from "../permissions/model-approval.js";
import { ResponsesProvider } from "../providers/responses-provider.js";
import {
  type ModelProvider,
  type ModelProviderFactory,
} from "../providers/model-provider.js";
import {
  captureModelProvider,
  replaySettings,
  type RecordedModelExchange,
} from "../sessions/replay-case.js";
import { ToolRunner } from "../tools/tool-runner.js";
import { ProjectMemoryService } from "../memory/service.js";
import { SandboxBroker } from "../sandbox/broker.js";
import { createSandboxRuntime } from "../sandbox/runtime-factory.js";
import { definitions, webSearchTool } from "../tools/registry.js";
import {
  DEFAULT_TOOL_CONCURRENCY,
  executeToolGraph,
  type ToolGraphNode,
} from "../tools/tool-graph.js";
import { redactJson, redactText } from "../logging/redact.js";
import { createSandboxLogger } from "../logging/logger.js";
import { tracedModelProvider } from "../tracing/model-provider.js";
import { TraceArchive } from "../tracing/archive.js";
import { TraceRecorder } from "../tracing/recorder.js";
import type { TraceSpan } from "../tracing/types.js";
import type { Task, TaskStatus } from "../shared/types.js";
import type { AgentRuntimeLauncher } from "../sandbox/agent-runtime-launcher.js";
import { AgentRuntimeFallbackError } from "../sandbox/agent-runtime-launcher.js";
import {
  RuntimeBrokerGateway,
  type RuntimeExecutionIdentity,
} from "../sandbox/runtime-capability-core.js";
import { RuntimeIpcBrokerSession } from "../sandbox/runtime-ipc-broker-session.js";
import { commandShell, resolveExecutablePath } from "../tools/command-shell.js";
import type { GitProcessResult, GitPushSpec } from "../tools/git.js";
import type {
  CapabilityCommandRequest,
  CapabilityCommandResult,
} from "../sandbox/capability-request.js";
import { buildAccessManifest } from "../sandbox/access-manifest.js";
import type { SandboxStatus } from "../sandbox/types.js";

// 标题请求没有工具或文件副作用；服务未提供可分类原因时，允许比主任务多一次诊断性重试。
const titleRetryOptions = { retries: 3, retryUnknownErrors: true };

type ModelUsagePurpose =
  "task" | "compaction" | "title" | "approval" | "subagent";

interface StartTaskOptions {
  subagentsEnabled?: boolean;
  recovery?: { sourceTaskId: string; originalPrompt: string };
}

type ActiveTask = {
  task: Task;
  workspace: string;
  controller: AbortController;
  done: Promise<void>;
};

export class Engine {
  events = new EventEmitter();
  approvals: ApprovalManager;
  private activeByTaskId = new Map<string, ActiveTask>();
  private approvalTasks = new WeakMap<ApprovalSubject, Task>();
  private closing = false;
  private scheduling = false;
  /** 全部宿主任务共享 Worker 配额；Sandbox Runtime 另须通过 Broker 取得同一全局 lease。 */
  private readonly subagentLimits = new SubagentLimits();
  /** 当前进程仅保留运行中任务构造 trace 所需的状态，任务落盘后立即释放。 */
  readonly traces = new TraceRecorder();
  /** 已结束任务的 trace 另行按会话/任务写入数据目录，服务重启后仍可下载。 */
  readonly traceArchive: TraceArchive;
  /** SandboxBroker 在任务内固定安全 fallback；执行已开始后的未知结果仍不会重放。 */
  readonly sandbox: SandboxBroker;
  /** Sandbox 安装、自检、Runtime、Broker 和 fallback 生命周期写入独立 sandbox.log。 */
  readonly sandboxLog: Logger;
  /** 项目记忆只写入平台数据目录；任务开始时读取固定 bundle，工具调用时执行受限维护操作。 */
  readonly memories: ProjectMemoryService;

  /** 保留单任务调用方的兼容访问；服务端新逻辑应使用 activeTasks 或 hasActiveTasks。 */
  get active() {
    return this.activeByTaskId.values().next().value as ActiveTask | undefined;
  }

  get activeTasks() {
    return [...this.activeByTaskId.values()].map(({ task }) => task);
  }

  get hasActiveTasks() {
    return this.activeByTaskId.size > 0 || this.store.queuedTasks().length > 0;
  }

  /** 下载只读取已经成功落盘的 trace，运行中或写入失败任务不会暴露不完整的内存数据。 */
  async savedTrace(task: Task) {
    return this.traceArchive.read(task.sessionId, task.id);
  }

  constructor(
    public store: Store,
    public config: Config,
    private log: Logger,
    private factory?: ModelProviderFactory,
    private agentRuntimeLauncher?: AgentRuntimeLauncher,
  ) {
    this.traceArchive = new TraceArchive(config.directory, log);
    this.sandboxLog = createSandboxLogger(
      config.directory,
      config.settings.logLevel,
      () => [config.apiKey],
    );
    this.sandbox = new SandboxBroker(
      config.sandbox,
      createSandboxRuntime(
        config.sandbox,
        process.platform,
        this.sandboxLog,
        this.traces,
      ),
      this.sandboxLog,
    );
    this.agentRuntimeLauncher ??=
      config.sandbox.enabled && process.platform === "win32"
        ? this.sandbox
        : undefined;
    this.memories = new ProjectMemoryService(config.directory, log);
    this.approvals = new ApprovalManager(
      () => this.updateWaitingTaskStatuses(),
      (subject, signal) => this.classifyApproval(subject, signal),
      (subject, assessment) => {
        const task = this.approvalTasks.get(subject);
        this.approvalTasks.delete(subject);
        if (task) {
          this.emit(task, "approval_assessed", {
            tool: subject.tool,
            decision: assessment.decision,
            reason: assessment.reason,
          });
        }
      },
    );
  }

  /** 审批始终优先使用显式配置的低成本模型；缺失、取消以外的故障不能自动放行。 */
  private async classifyApproval(
    subject: ApprovalSubject,
    signal: AbortSignal,
  ): Promise<ApprovalAssessment> {
    // 即使未配置辅助模型，也要把后续人工审批评估事件归属到正确的并发任务。
    const active = this.activeForSignal(signal);
    const task = active?.task;
    if (task) {
      this.approvalTasks.set(subject, task);
    }

    const settings = { ...this.config.settings };
    if (!settings.auxiliaryModel?.trim()) {
      return {
        decision: "human review",
        reason: "未配置低成本审批模型，需要人工确认。",
      };
    }

    const selected = auxiliarySettings(settings);
    const provider =
      this.factory?.(selected, "approval") ??
      new ResponsesProvider(selected, this.config.apiKey);

    try {
      if (task) {
        this.emit(task, "model_request", { purpose: "approval" });
      }

      const assessment = await assessApproval(
        task
          ? tracedModelProvider(
              this.replayProvider(task, provider, () => ({
                purpose: "approval",
              })),
              this.traces,
              {
                taskId: task.id,
                purpose: "approval",
                model: selected.model,
              },
            )
          : provider,
        subject,
        signal,
        (usage) => {
          if (task) {
            this.recordModelUsage(task, usage, "approval");
          }
        },
      );
      this.log.info({
        event: "approval.assessed",
        module: "permissions",
        tool: subject.tool,
        decision: assessment.decision,
      });

      return assessment;
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }

      this.log.warn({
        event: "approval.assessment_failed",
        module: "permissions",
        tool: subject.tool,
        err: error,
      });

      return {
        decision: "human review",
        reason: "低成本审批模型不可用或返回无效结果，需要人工确认。",
      };
    }
  }

  /** HTTP 快照首次加载全量事件，后续刷新只解析游标后的新增事件；任务状态和审批始终从小索引重新读取。 */
  async snapshot(id: string, after = 0) {
    const events = await this.store.eventsAsync(id, after);

    return {
      session: this.store.get(id),
      events,
      tasks: this.store.tasks(id),
      approvals: this.approvals.list(id),
    };
  }

  private emit(task: Task, type: string, data: any) {
    const clean = JSON.parse(
      redactJson(JSON.stringify(data), [this.config.apiKey]),
    );
    const event = this.store.event(task.sessionId, task.id, type, clean);

    this.events.emit("event", event);
    this.events.emit("change", task.sessionId);
  }

  /** 每次得到服务实报 usage 都随会话保存；缺失 usage 不补零，调用次数由 model_request 独立记录。 */
  private recordModelUsage(
    task: Task,
    usage: ModelUsage,
    purpose: ModelUsagePurpose,
    details: { step?: number; attempt?: number; subagentId?: string } = {},
  ) {
    this.emit(task, "model_usage", { ...usage, purpose, ...details });
    this.log.info({ event: "model.usage", purpose, ...details, ...usage });
  }

  /** replay 捕获与任务历史同库保存；脱敏后才进入本地高保真材料，trace 仍只保留安全摘要。 */
  private replayProvider(
    task: Task,
    provider: ModelProvider,
    details: () => Pick<RecordedModelExchange, "purpose" | "step" | "attempt">,
  ) {
    const clean = <T>(value: T) =>
      JSON.parse(redactJson(JSON.stringify(value), [this.config.apiKey])) as T;

    return captureModelProvider(
      provider,
      {
        startModelExchange: (exchange) => {
          this.store.startReplayModelExchange(task.id, clean(exchange));

          return exchange.id;
        },
        finishModelExchange: (id, outcome) =>
          this.store.finishReplayModelExchange(task.id, id, clean(outcome)),
      },
      details,
    );
  }

  start(sessionId: string, prompt: string, options: StartTaskOptions = {}) {
    if (options.subagentsEnabled) {
      throw new Error("subagent 尚未就绪，不能启用本次任务。");
    }

    if (this.closing) {
      throw new Error("服务正在关闭，不能启动任务。");
    }

    const session = this.store.get(sessionId);

    if (!session) {
      throw new Error("会话不存在");
    }

    // 同一会话的历史上下文只能由一个任务追加。跨会话排队由 workspace 锁和全局上限处理。
    const task = this.store.transaction(() => {
      if (this.store.hasUnfinishedTask(sessionId)) {
        throw new Error("当前会话已有运行中或排队中的任务，请等待或取消。");
      }

      const created = this.store.createTask(
        sessionId,
        options.subagentsEnabled ?? false,
      );
      const firstPrompt =
        session.titleState === "pending" &&
        !this.store.hasEvent(sessionId, "user");

      this.emit(created, "user", { text: prompt });
      if (options.recovery) {
        this.emit(created, "recovery", options.recovery);
      }

      if (firstPrompt) {
        this.store.startTitleGeneration(sessionId);
      }

      return created;
    });

    this.events.emit("change", sessionId);
    this.schedule();

    return this.store.task(task.id)!;
  }

  /** 找到给定 AbortSignal 所属任务，避免并发审批事件误写入另一个会话。 */
  private activeForSignal(signal: AbortSignal) {
    return [...this.activeByTaskId.values()].find(
      (active) => active.controller.signal === signal,
    );
  }

  /** 每项审批只影响提出它的任务；其他会话仍可继续运行或等待自己的确认。 */
  private updateWaitingTaskStatuses() {
    for (const active of this.activeByTaskId.values()) {
      const waiting = this.approvals
        .list(active.task.sessionId)
        .some((approval) => approval.taskId === active.task.id);
      this.store.status(active.task.id, waiting ? "waiting" : "running");
      this.events.emit("change", active.task.sessionId);
    }
  }

  /** 在全局上限内领取不与已运行任务共享真实工作区的最早队列项；被工作区锁阻塞的项保持排队。 */
  private schedule() {
    if (this.closing || this.scheduling) {
      return;
    }

    this.scheduling = true;
    try {
      while (
        this.activeByTaskId.size < this.config.settings.maxConcurrentTasks
      ) {
        const next = this.store
          .queuedTasks()
          .find(
            (candidate) =>
              ![...this.activeByTaskId.values()].some(
                (active) => active.workspace === candidate.workspace,
              ),
          );
        if (!next) {
          return;
        }

        this.launch(next);
      }
    } finally {
      this.scheduling = false;
    }
  }

  /** 将已领取任务转为 running 后再启动异步循环，确保同工作区的后续任务看见锁。 */
  private launch(queued: Task & { workspace: string }) {
    const user = this.store.taskEvent(queued.id, "user") as
      { text?: string } | undefined;
    if (!user?.text) {
      this.store.failTitleGeneration(queued.sessionId);
      this.store.status(queued.id, "failed", "缺少任务描述，无法执行。");
      this.emit(queued, "task_end", { status: "failed" });
      this.events.emit("change", queued.sessionId);

      return;
    }

    this.store.status(queued.id, "running");
    const task = this.store.task(queued.id)!;
    const controller = new AbortController();
    const active: ActiveTask = {
      task,
      workspace: queued.workspace,
      controller,
      done: Promise.resolve(),
    };
    this.activeByTaskId.set(task.id, active);
    const generateTitle =
      this.store.get(task.sessionId)?.titleState === "generating";

    active.done = this.run(task, user.text, controller.signal, generateTitle)
      .catch((error) => {
        this.log.error({
          event: "task.persistence_failed",
          module: "agent",
          taskId: task.id,
          err: error,
        });
        try {
          this.store.status(
            task.id,
            "failed",
            "任务持久化异常，请检查存储空间和权限后恢复。",
          );
        } catch {
          /* 下次启动时会将未完成任务标为中断。 */
        }
      })
      .finally(() => {
        this.activeByTaskId.delete(task.id);
        this.events.emit("change", task.sessionId);
        this.schedule();
      });
    this.events.emit("change", task.sessionId);
  }

  resume(id: string, instruction = "") {
    const task = this.store.task(id);

    if (
      !task ||
      !["failed", "cancelled", "interrupted"].includes(task.status)
    ) {
      throw new Error("该任务不可恢复。");
    }

    if (this.store.tasks(task.sessionId).at(-1)?.id !== id) {
      throw new Error("只能恢复会话的最后一个任务；请在当前会话继续提问。");
    }

    const recovery = this.store.taskEvent(id, "recovery") as
      { originalPrompt?: string } | undefined;
    const user = this.store.taskEvent(id, "user") as
      { text?: string } | undefined;
    const prompt = recovery?.originalPrompt || user?.text;

    if (!prompt) {
      throw new Error("缺少原任务描述，请在当前会话重新说明任务。");
    }

    return this.start(
      task.sessionId,
      "恢复上次任务。原任务要求：\n" +
        prompt +
        "\n保留已完成的进度；先核实当前文件和不确定操作的状态，不要盲目重放命令。\n" +
        instruction,
      {
        subagentsEnabled: task.subagentsEnabled,
        recovery: { sourceTaskId: id, originalPrompt: prompt },
      },
    );
  }

  cancel(id: string) {
    const active = this.activeByTaskId.get(id);
    if (active) {
      active.controller.abort();

      return;
    }

    const queued = this.store.task(id);
    if (queued?.status === "queued") {
      this.store.failTitleGeneration(queued.sessionId);
      this.store.status(id, "cancelled", "任务已在队列中取消，可手动恢复。");
      this.emit(queued, "notice", {
        text: "任务已在队列中取消，可手动恢复。",
        status: "cancelled",
      });
      this.emit(queued, "task_end", { status: "cancelled" });
      this.events.emit("change", queued.sessionId);
      this.schedule();
    }
  }

  async close() {
    this.closing = true;
    try {
      for (const queued of this.store.queuedTasks()) {
        const message = "服务关闭，任务中断，可手动恢复。";
        this.store.failTitleGeneration(queued.sessionId);
        this.store.status(queued.id, "interrupted", message);
        this.emit(queued, "notice", { text: message, status: "interrupted" });
        this.emit(queued, "task_end", { status: "interrupted" });
        this.events.emit("change", queued.sessionId);
      }

      const active = [...this.activeByTaskId.values()];
      for (const item of active) {
        item.controller.abort(new Error("服务关闭，任务中断，可手动恢复。"));
      }

      await Promise.all(active.map((item) => item.done));
      await this.sandbox.shutdown();
    } finally {
      this.closing = false;
    }
  }

  /** 生成标题失败时保留占位值；只有取消需要中止主任务，避免辅助能力降低可用性。 */
  private async generateTitle(
    task: Task,
    prompt: string,
    settings: Settings,
    signal: AbortSignal,
    log: Logger,
  ) {
    const selected = auxiliarySettings(settings);
    const provider =
      this.factory?.(selected, "auxiliary") ??
      new ResponsesProvider(selected, this.config.apiKey);

    try {
      const title = await retryModel(
        (attempt) => {
          this.emit(task, "model_request", { purpose: "title", attempt });

          return generateConversationTitle(
            tracedModelProvider(
              this.replayProvider(task, provider, () => ({
                purpose: "title",
                attempt,
              })),
              this.traces,
              {
                taskId: task.id,
                purpose: "title",
                model: selected.model,
                attempt,
              },
            ),
            prompt,
            signal,
            (usage) => this.recordModelUsage(task, usage, "title", { attempt }),
          );
        },
        signal,
        (error, attempt, delayMs) => {
          log.warn({
            event: "session.title_generation_retry",
            model: selected.model,
            attempt,
            delayMs,
            code: error.code,
          });
        },
        titleRetryOptions,
      );

      this.store.completeTitleGeneration(task.sessionId, title);
      this.events.emit("change", task.sessionId);
      log.info({
        event: "session.title_generated",
        model: selected.model,
        titleLength: title.length,
      });
    } catch (error: any) {
      if (signal.aborted) {
        // 取消后的请求不会返回结果；结束标题状态，防止恢复任务永久卡在 generating。
        this.store.failTitleGeneration(task.sessionId);
        this.events.emit("change", task.sessionId);
        throw signal.reason;
      }

      this.store.failTitleGeneration(task.sessionId);
      this.events.emit("change", task.sessionId);
      log.warn({
        event: "session.title_generation_failed",
        model: selected.model,
        code: error?.code,
        err: error,
      });
    }
  }

  /**
   * Broker 路径只启动/监督 Runtime 并实现固定 adapter；模型轮次、上下文和工具 DAG 均由子进程 AgentRuntimeService 发起。
   * 注入 launcher 仅用于已经完成进程身份验证的 transport；普通子进程 launcher 只能用于测试，不得在产品配置中冒充 Sandbox。
   */
  private async runInAgentRuntime(
    task: Task,
    workspace: string,
    prompt: string,
    settings: Settings,
    signal: AbortSignal,
    emit: (type: string, data: any) => void,
    captureToolEvent: (type: string, data: any) => void,
  ): Promise<{ status: TaskStatus; failure?: string }> {
    const launcher = this.agentRuntimeLauncher!;
    const runtimeContextSpans = new Map<string, TraceSpan | undefined>();
    const executionInstanceId = randomUUID();
    const identity: RuntimeExecutionIdentity = {
      sessionId: task.sessionId,
      taskId: task.id,
      executionInstanceId,
      kind: "agent-runtime",
    };
    const nonce = randomBytes(32).toString("hex");
    let authorized = true;
    let launched:
      Awaited<ReturnType<AgentRuntimeLauncher["launch"]>> | undefined;
    let cleaned = false;
    let closeAttempted = false;
    const createdAt = new Date().toISOString();
    const publishExecution = (
      state:
        | "created"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
        | "unknown",
      extra: Record<string, unknown> = {},
    ) => {
      const record = {
        executionInstanceId,
        kind: "agent-runtime" as const,
        mode: "windows-sandbox-user" as const,
        state,
        createdAt,
        updatedAt: new Date().toISOString(),
        sandboxRequested: true,
        sandboxApplied: state !== "created",
        ...extra,
      };
      emit("execution_instance", record);
      this.sandbox.recordExecutionInstance(record);
    };

    const publishSandboxStage = (
      stage: "executing" | "completed" | "failed",
      override?: SandboxStatus,
    ) => {
      const status =
        override ?? this.sandbox.statusFor(task.id, executionInstanceId);
      if (status.mode !== "unknown" || stage === "failed") {
        emit("sandbox_stage", { stage, executionInstanceId, ...status });
      }
    };

    publishExecution("created");
    try {
      try {
        launched = await launcher.launch({
          identity,
          nonce,
          workspace,
          signal,
        });
      } catch (error) {
        if (error instanceof AgentRuntimeFallbackError) {
          publishExecution("failed", {
            mode: "host-process",
            sandboxApplied: false,
            failureCategory: "runtime_self_check",
            sideEffectsPossible: false,
          });
          publishSandboxStage("failed", {
            enabled: true,
            requested: true,
            applied: false,
            mode: "host-process-fallback",
            platform: process.platform,
            level: null,
            reason: error.message,
            failureCategory: "runtime_self_check",
          });
        }

        throw error;
      }

      publishExecution("running", {
        pid: launched.pid,
        pidKind: "runtime",
        processCreationTime100ns: launched.processCreationTime100ns,
        accountGenerationDigest: launched.accountGenerationDigest,
      });
      publishSandboxStage("executing");
      const gateway = new RuntimeBrokerGateway(
        {
          authorize: (candidate) => authorized && candidate === identity,
          approveCommand: async (_runtime, request, requestSignal) => ({
            approved: await this.approvals.request(
              {
                sessionId: task.sessionId,
                taskId: task.id,
                tool: "command",
                description: `允许在工作区执行命令：${request.command}`,
              },
              requestSignal,
            ),
          }),
          modelProvider: (_runtime, purpose) => {
            const selected =
              purpose === "compaction" && settings.auxiliaryModel
                ? auxiliarySettings(settings)
                : settings;
            const provider =
              this.factory?.(
                selected,
                purpose === "compaction" ? "auxiliary" : "task",
              ) ?? new ResponsesProvider(selected, this.config.apiKey);

            return {
              model: selected.model,
              provider: this.replayProvider(task, provider, () => ({
                purpose,
              })),
            };
          },
        },
        this.traces,
        this.sandboxLog,
      );
      let reported:
        | {
            status: TaskStatus;
            failure?: string;
          }
        | undefined;
      const broker = new RuntimeIpcBrokerSession(
        { input: launched.input, output: launched.output },
        identity,
        nonce,
        gateway,
        {
          traceSpan: (event) => {
            if (event.event === "trace_span_start") {
              if (runtimeContextSpans.has(event.spanId)) {
                throw new Error("Agent Runtime trace span 标识重复。");
              }

              const parent = event.parentSpanId
                ? runtimeContextSpans.get(event.parentSpanId)
                : undefined;
              if (event.parentSpanId && !parent) {
                throw new Error("Agent Runtime trace parent 不存在。");
              }

              runtimeContextSpans.set(
                event.spanId,
                this.traces.startSpan(task.id, {
                  name: event.name,
                  category: "context",
                  track: "Main thread",
                  parentSpanId: parent?.id,
                  attributes: event.attributes,
                }),
              );

              return;
            }

            const span = runtimeContextSpans.get(event.spanId);
            if (!span) {
              throw new Error(
                "Agent Runtime trace span 终态没有对应开始事件。",
              );
            }

            this.traces.endSpan(span, event.status, event.attributes);
            runtimeContextSpans.delete(event.spanId);
          },
          executeGitPush: (_runtime, spec, toolCallId, requestSignal) =>
            this.executeRuntimeGitPush(
              task,
              workspace,
              spec,
              toolCallId,
              requestSignal,
              settings,
              emit,
            ),
          prepareCapabilityCommand: (
            _runtime,
            request,
            toolCallId,
            requestSignal,
          ) =>
            this.prepareRuntimeCapabilityCommand(
              task,
              workspace,
              request,
              toolCallId,
              requestSignal,
              settings,
              emit,
            ),
          requestApproval: async (_runtime, request, requestSignal) => ({
            approved: await this.approvals.request(
              {
                sessionId: task.sessionId,
                taskId: task.id,
                tool: request.tool,
                description: request.description,
              },
              requestSignal,
              request.grantKey,
            ),
          }),
          applyMemory: (_runtime, request) =>
            this.memories.apply(
              {
                workspace,
                sessionId: task.sessionId,
                taskId: task.id,
              },
              request,
            ),
          appendSessionEvent: async (_runtime, type, data) => {
            captureToolEvent(type, data);
            emit(type, data);
          },
          saveContext: async (_runtime, input) => {
            this.store.saveContext(task.sessionId, input);
          },
          readContext: () => this.store.contextAsync(task.sessionId),
          readEvents: () => this.store.eventsAsync(task.sessionId),
          latestContextSnapshot: () =>
            this.store.latestContextSnapshotAsync(task.sessionId),
          readContextSnapshot: (_runtime, snapshotId) =>
            this.store.contextSnapshotAsync(task.sessionId, snapshotId),
          compactContext: async (_runtime, snapshot, input) => {
            if (snapshot.sessionId !== task.sessionId) {
              throw new Error("Agent Runtime 压缩快照不属于认证会话。");
            }

            if (
              snapshot.parentId !== null &&
              !(await this.store.contextSnapshotAsync(
                task.sessionId,
                snapshot.parentId,
              ))
            ) {
              throw new Error("Agent Runtime 压缩快照的父快照不属于认证会话。");
            }

            await this.store.compactContextAsync(
              task.sessionId,
              snapshot,
              input,
            );
          },
          runtimeCompleted: async (_runtime, result) => {
            reported = result;
          },
        },
      );
      const cancelled = () => broker.cancel("Broker 任务已取消。");
      signal.addEventListener("abort", cancelled, { once: true });
      const memory = await this.memories.retrieve(workspace, prompt);
      try {
        const response = (await broker.startTask(
          {
            workspace,
            prompt,
            settings: {
              model: settings.model,
              maxSteps: settings.maxSteps,
              commandTimeoutMs: settings.commandTimeoutMs,
              maxOutputTokens: settings.maxOutputTokens,
              contextChars: settings.contextChars,
              outputChars: settings.outputChars,
            },
            memoryText: memory.bundle?.text,
          },
          signal,
        )) as { status?: TaskStatus; failure?: string };
        const status = reported?.status ?? response.status;
        if (
          status !== "completed" &&
          status !== "failed" &&
          status !== "cancelled" &&
          status !== "interrupted"
        ) {
          throw new Error("Agent Runtime 未返回有效任务终态。");
        }

        closeAttempted = true;
        const cleanup = await launched
          .close(
            status === "completed"
              ? "completed"
              : signal.aborted
                ? "cancel"
                : "failed",
          )
          .catch(() => "orphaned" as const);
        cleaned = cleanup === "clean";
        authorized = false;
        if (!cleaned) {
          publishExecution("unknown", { sideEffectsPossible: true });
          publishSandboxStage("failed");
          throw new Error(
            "Agent Runtime 清理结果未知，账户 generation 必须隔离。",
          );
        }

        publishExecution(
          status === "completed"
            ? "completed"
            : status === "cancelled" || status === "interrupted"
              ? "cancelled"
              : "failed",
          {
            sideEffectsPossible:
              status === "cancelled" || status === "interrupted",
          },
        );
        publishSandboxStage(status === "completed" ? "completed" : "failed");

        return { status, failure: reported?.failure ?? response.failure };
      } finally {
        signal.removeEventListener("abort", cancelled);
      }
    } finally {
      authorized = false;
      for (const span of runtimeContextSpans.values()) {
        this.traces.endSpan(span, signal.aborted ? "cancelled" : "error", {
          incomplete: true,
        });
      }

      runtimeContextSpans.clear();
      if (launched && !closeAttempted) {
        closeAttempted = true;
        const closeReason = signal.aborted ? "cancel" : "unknown";
        const cleanup = await launched
          .close(closeReason)
          .catch(() => "orphaned" as const);
        if (closeReason === "unknown" || cleanup !== "clean") {
          publishExecution("unknown", { sideEffectsPossible: true });
          publishSandboxStage("failed");
        } else {
          publishExecution("cancelled", { sideEffectsPossible: true });
          publishSandboxStage("failed");
        }
      }
    }
  }

  /**
   * Agent Runtime 在此请求上保持存活并同步等待；只有独立 Push Runner 获得 relay/credential lease。
   * Broker 从 PushSpec 重建固定参数，且明确禁止 Sandbox 启动失败时回退为宿主 Git。
   */
  private async executeRuntimeGitPush(
    task: Task,
    workspace: string,
    spec: GitPushSpec,
    toolCallId: string,
    signal: AbortSignal,
    settings: Settings,
    emit: (type: string, data: any) => void,
  ): Promise<GitProcessResult> {
    const remoteUrl = new URL(spec.remoteUrl);
    if (
      remoteUrl.protocol !== "https:" ||
      remoteUrl.hostname.toLocaleLowerCase() !==
        spec.host.toLocaleLowerCase() ||
      remoteUrl.username ||
      remoteUrl.password
    ) {
      throw new Error("PushSpec 的 HTTPS remote 与获准 host 不一致。");
    }

    const allowed = await this.approvals.request(
      {
        sessionId: task.sessionId,
        taskId: task.id,
        tool: "git_push",
        description: `允许单次 HTTPS push 到 ${spec.host}，目标 ${spec.refspec}，当前对象 ${spec.objectId.slice(0, 12)}。该主机可接收仓库内容，Git 配置、hook 及其子进程会在本次网络窗口内运行。`,
      },
      signal,
    );
    if (!allowed) {
      throw new Error("Sandbox Git push 审批未通过。");
    }

    const outcome = await executeSandboxRunner(this.sandbox, {
      taskId: task.id,
      toolCallId,
      kind: "push-runner",
      signal,
      fallbackError: "Push Runner 禁止宿主 Git fallback。",
      emit,
      command: () => ({
        sessionId: task.sessionId,
        networkHost: spec.host,
        command: resolveExecutablePath("git"),
        args: [
          "push",
          "--porcelain",
          spec.remote,
          `${spec.objectId}:${spec.refspec.slice("HEAD:".length)}`,
        ],
        cwd: workspace,
        timeoutMs: settings.commandTimeoutMs,
        outputLimit: settings.outputChars,
        onOutput: (text) => emit("git_output", { text }),
      }),
    });

    return outcome.result;
  }

  /**
   * Broker 审核 Runtime 声明的最小扩展权限，返回只可调用一次的 restricted Runner 启动闭包。
   * 声明只接受现有递归目录根和单一 HTTPS host；调用方取得 Tool worker 槽后才执行闭包，
   * 且任何启动前失败都禁止回退到宿主用户权限。
   */
  private async prepareRuntimeCapabilityCommand(
    task: Task,
    workspace: string,
    request: CapabilityCommandRequest,
    toolCallId: string,
    signal: AbortSignal,
    settings: Settings,
    emit: (type: string, data: any) => void,
  ): Promise<(signal: AbortSignal) => Promise<CapabilityCommandResult>> {
    const normalizeRoots = (roots: string[]) => {
      const seen = new Set<string>();

      return roots.map((root) => {
        if (!path.isAbsolute(root)) {
          throw new Error("扩展文件根必须是绝对路径。");
        }

        const normalized = path.resolve(root);
        const key =
          process.platform === "win32"
            ? normalized.toLocaleLowerCase()
            : normalized;
        if (seen.has(key)) {
          throw new Error("扩展权限包含重复文件根。");
        }

        seen.add(key);

        return normalized;
      });
    };

    const requestedReadRoots = normalizeRoots(request.permissions.readRoots);
    const requestedWriteRoots = normalizeRoots(request.permissions.writeRoots);
    const readKeys = new Set(
      requestedReadRoots.map((root) =>
        process.platform === "win32" ? root.toLocaleLowerCase() : root,
      ),
    );
    if (
      requestedWriteRoots.some((root) =>
        readKeys.has(
          process.platform === "win32" ? root.toLocaleLowerCase() : root,
        ),
      )
    ) {
      throw new Error("同一扩展文件根不能同时声明为只读和可写。");
    }

    // 审批前先以与正式 provision 相同的规则打开对象并取得规范路径；审批后
    // Broker 和原生 supervisor 仍会重新打开并核对身份，防止审批替代执行时校验。
    const reviewedManifest = await buildAccessManifest({
      workspaceRoot: workspace,
      readOnlyRoots: requestedReadRoots,
      readWriteRoots: requestedWriteRoots,
    });
    const readOnlyRoots = reviewedManifest.readRoots.map((root) => root.path);
    const readWriteRoots = reviewedManifest.writeRoots
      .filter((root) => root.rootId !== reviewedManifest.workspaceRootId)
      .map((root) => root.path);
    if (readWriteRoots.length !== requestedWriteRoots.length) {
      throw new Error("工作区已经属于 Agent Runtime 权限，不能重复申请。");
    }

    const networkHost = request.permissions.httpsHost?.toLocaleLowerCase();
    const shell = commandShell(process.env, undefined, process.platform, false);
    if (!shell) {
      throw new Error("当前平台未找到 capability runner 可用的命令 shell。");
    }

    const allowed = await this.approvals.request(
      {
        sessionId: task.sessionId,
        taskId: task.id,
        tool: "run_with_permissions",
        description: JSON.stringify(
          {
            command: request.command,
            permissions: {
              readRoots: readOnlyRoots,
              writeRoots: readWriteRoots,
              httpsHost: networkHost ?? null,
            },
            reason: request.reason,
          },
          null,
          2,
        ),
      },
      signal,
    );
    if (!allowed) {
      throw new Error("扩展权限命令审批未通过。");
    }

    return async (executionSignal) => {
      executionSignal.throwIfAborted();
      const outcome = await executeSandboxRunner(this.sandbox, {
        taskId: task.id,
        toolCallId,
        kind: "capability-runner",
        signal: executionSignal,
        fallbackError: "扩展权限 Runner 禁止宿主权限 fallback。",
        emit,
        command: () => ({
          sessionId: task.sessionId,
          networkHost,
          readOnlyRoots,
          readWriteRoots,
          reviewedAccessManifest: reviewedManifest,
          command: shell.command,
          args: [...shell.args, request.command],
          cwd: workspace,
          timeoutMs: settings.commandTimeoutMs,
          outputLimit: settings.outputChars,
          onOutput: (text) => emit("capability_output", { text }),
        }),
      });

      return {
        executionInstanceId: outcome.executionInstanceId,
        ...outcome.result,
      };
    };
  }

  private async run(
    task: Task,
    prompt: string,
    signal: AbortSignal,
    generateTitle: boolean,
  ) {
    const session = this.store.get(task.sessionId)!;
    const settings = { ...this.config.settings };
    const log = this.log.child({
      module: "agent",
      sessionId: session.id,
      taskId: task.id,
    });

    log.info({ event: "task.started" });
    this.traces.startTask(task.id, task.sessionId);
    let status: TaskStatus = "completed";
    let failure: string | undefined;
    const emit = (type: string, data: any) => this.emit(task, type, data);
    let step = 0;
    let attempt = 1;
    let buffer = "";
    let lastFlush = 0;
    let replayCaptureSpan: TraceSpan | undefined;
    let subagents: SubagentCoordinator | undefined;
    const cleanReplay = <T>(value: T) =>
      JSON.parse(redactJson(JSON.stringify(value), [this.config.apiKey])) as T;
    const flush = () => {
      if (buffer) {
        emit("delta", { text: buffer, step, attempt });
        buffer = "";
        lastFlush = Date.now();
      }
    };

    try {
      this.store.startReplayCapture(task, {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        platform: process.platform,
        settings: replaySettings(settings),
      });
      replayCaptureSpan = this.traces.startSpan(task.id, {
        name: "replay.capture",
        category: "storage",
        track: "Main thread",
      });
      if (generateTitle) {
        await this.generateTitle(task, prompt, settings, signal, log);
      }

      if (this.agentRuntimeLauncher && this.config.sandbox.enabled) {
        const runtimeToolSpans = new Map<string, TraceSpan | undefined>();
        let runtimeCompactionSpan: TraceSpan | undefined;
        const captureRuntimeToolEvent = (type: string, data: any) => {
          if (type === "tool_start") {
            this.store.startReplayTool(
              task.id,
              cleanReplay({
                name: data.name,
                callId: data.callId,
                batchId: data.batchId,
                nodeId: data.nodeId,
                dependsOn: data.dependsOn,
                arguments: data.args,
              }),
            );
            runtimeToolSpans.set(
              data.callId,
              this.traces.startSpan(task.id, {
                name: `tool.${String(data.name).slice(0, 80)}`,
                category: "tool",
                track: "Agent Runtime tools",
                attributes: {
                  batchId: data.batchId,
                  callId: data.callId,
                  nodeId: data.nodeId,
                  executionInstanceId: undefined,
                  parameters:
                    data.name === "run_with_permissions"
                      ? JSON.parse(
                          redactJson(JSON.stringify(data.args), [
                            this.config.apiKey,
                          ]),
                        )
                      : undefined,
                },
              }),
            );
          } else if (type === "tool_result") {
            this.store.finishReplayTool(
              task.id,
              data.callId,
              cleanReplay(data.result),
            );
            const span = runtimeToolSpans.get(data.callId);

            this.traces.endSpan(span, data.result?.error ? "error" : "ok");
            runtimeToolSpans.delete(data.callId);
          } else if (type === "tool_batch_planned") {
            this.traces.instant(
              task.id,
              "tool.plan",
              "tool",
              "Agent Runtime tools",
              {
                batchId: data.batchId,
                nodes: Array.isArray(data.nodes) ? data.nodes.length : 0,
              },
            );
          } else if (type === "context.compaction_started") {
            runtimeCompactionSpan = this.traces.startSpan(task.id, {
              name: "context.compaction",
              category: "context",
              track: "Agent Runtime context",
              attributes: {
                stage: data.stage,
                beforeAmount: data.beforeAmount,
              },
            });
          } else if (
            type === "context.compaction_completed" ||
            type === "context.compaction_failed"
          ) {
            this.traces.endSpan(
              runtimeCompactionSpan,
              type.endsWith("failed") ? "error" : "ok",
              {
                stage: data.stage,
                afterAmount: data.afterAmount,
              },
            );
            runtimeCompactionSpan = undefined;
          }
        };

        try {
          const result = await this.runInAgentRuntime(
            task,
            session.workspace,
            prompt,
            settings,
            signal,
            emit,
            captureRuntimeToolEvent,
          );
          status = result.status;
          failure = result.failure;

          return;
        } catch (error) {
          if (!(error instanceof AgentRuntimeFallbackError)) {
            throw error;
          }

          emit("sandbox_fallback", {
            reason: error.message,
            mode: "host-process-fallback",
          });
        }
      }

      let input = await prepareTaskContext(this.store, session.id, prompt);

      const runner = new ToolRunner({
        root: session.workspace,
        sessionId: session.id,
        taskId: task.id,
        signal,
        settings,
        approvals: this.approvals,
        emit,
        sandbox: this.sandbox,
        memory: this.memories,
        onSandboxStage: (stage, status, executionInstanceId) => {
          this.traces.instant(
            task.id,
            `sandbox.${stage}`,
            "sandbox",
            "Main thread",
            {
              mode: status.mode,
              enabled: status.enabled,
              level: status.level,
              executionInstanceId,
            },
          );
        },
        onExecutionInstance: (record) => {
          this.traces.instant(
            task.id,
            `sandbox.execution_instance.${record.state}`,
            "sandbox",
            "Main thread",
            {
              executionInstanceId: record.executionInstanceId,
              kind: record.kind,
              mode: record.mode,
              pidKind: record.pidKind,
              processCreationTime100ns: record.processCreationTime100ns,
              requested: record.sandboxRequested,
              applied: record.sandboxApplied,
              sideEffectsPossible: record.sideEffectsPossible,
            },
          );
        },
      });
      // Runtime 启动前 fallback 已回到宿主权限模型；不能沿用仅 Runtime 可执行的提示或工具。
      const baseInstructions = await createInstructions(session.workspace);
      const memorySpan = this.traces.startSpan(task.id, {
        name: "memory.retrieve",
        category: "memory",
        track: "Main thread",
      });
      const memory = await this.memories.retrieve(session.workspace, prompt);
      this.traces.endSpan(memorySpan, memory.available ? "ok" : "error", {
        available: memory.available,
        entries: memory.bundle?.entries.length ?? 0,
      });
      emit("memory_retrieved", {
        available: memory.available,
        entries: memory.bundle?.entries.length ?? 0,
      });
      if (!memory.available) {
        emit("notice", { text: "项目记忆不可用，当前任务将不使用历史记忆。" });
      }

      const instructions = [
        baseInstructions,
        memory.bundle?.text,
        task.subagentsEnabled
          ? "This task opted into read-only subagents. After inspecting the relevant code, use the subagent tool only for bounded independent research. You alone plan all edits, re-read current files, verify any subagent evidence and write the final answer. Never delegate file writes or permission upgrades."
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");

      const provider =
        this.factory?.(settings, "task") ||
        new ResponsesProvider(settings, this.config.apiKey);

      if (task.subagentsEnabled) {
        const subagentSpans = new Map<string, TraceSpan | undefined>();
        subagents = new SubagentCoordinator({
          taskId: task.id,
          workspace: session.workspace,
          storage: this.store,
          provider,
          limits: this.subagentLimits,
          signal,
          onModelRequest: (subagentId) =>
            emit("model_request", { purpose: "subagent", subagentId }),
          onUsage: (subagentId, usage) =>
            this.recordModelUsage(task, usage, "subagent", { subagentId }),
          trace: (name, subagentId, state, durationMs) => {
            const key = `${name}:${subagentId}`;
            if (state === "started") {
              const span = this.traces.startSpan(task.id, {
                name,
                category: "subagent",
                track: `Subagent ${subagentId}`,
                attributes: { subagentId },
              });
              subagentSpans.set(key, span);
            } else {
              this.traces.endSpan(
                subagentSpans.get(key),
                state === "ok" || state === "completed"
                  ? "ok"
                  : state === "cancelled"
                    ? "cancelled"
                    : "error",
                { durationMs },
              );
              subagentSpans.delete(key);
            }
          },
        });
      }

      let capabilities: ModelCapabilities | undefined;
      try {
        capabilities = await provider.getCapabilities?.(signal);
      } catch (error) {
        signal.throwIfAborted();
        log.warn({ event: "model.capabilities_unavailable", err: error });
      }

      const budget = createBudget(
        capabilities,
        settings.contextChars,
        settings.maxOutputTokens,
      );
      emit("context_budget", {
        model: settings.model,
        unit: budget.unit,
        inputLimit: budget.limit,
        contextWindowTokens: capabilities?.limits.max_context_window_tokens,
        modelMaxOutputTokens: capabilities?.limits.max_output_tokens,
        outputTokens: budget.outputTokens,
        safetyTokens: budget.safetyTokens,
        tokenizer: budget.tokenizer,
      });
      log.info({
        event: "context.budget_selected",
        unit: budget.unit,
        inputLimit: budget.limit,
      });
      const recordUsage = (
        usage: ModelUsage,
        purpose: "task" | "compaction",
      ) => {
        this.recordModelUsage(task, usage, purpose, {
          step,
          attempt: purpose === "task" ? attempt : undefined,
        });
      };

      // web_search 由 Responses 服务在单次模型请求内完成；仅本地 function_call 才进入后续 DAG。
      const tools = [
        ...definitions,
        webSearchTool,
        historyDefinition,
        ...(task.subagentsEnabled ? [subagentToolDefinition] : []),
      ];
      let compactionSpan: TraceSpan | undefined;
      let contextTraceParent: TraceSpan | undefined;
      const contextStageSpans: Array<TraceSpan | undefined> = [];
      const contextTrace: ContextTrace = {
        start: (name, attributes) => {
          const parentSpan =
            contextStageSpans.at(-1) ?? compactionSpan ?? contextTraceParent;
          const span = this.traces.startSpan(task.id, {
            name,
            category: "context",
            track: "Main thread",
            parentSpanId: parentSpan?.id,
            attributes,
          });
          contextStageSpans.push(span);

          return span;
        },
        end: (handle, status, attributes) => {
          const span = handle as TraceSpan | undefined;
          this.traces.endSpan(span, status, attributes);
          const index = contextStageSpans.lastIndexOf(span);
          if (index >= 0) {
            contextStageSpans.splice(index, 1);
          }
        },
        currentSpanId: () =>
          contextStageSpans.at(-1)?.id ??
          compactionSpan?.id ??
          contextTraceParent?.id,
      };
      const compactionAttributes = (data: Record<string, unknown>) => ({
        step,
        beforeAmount:
          typeof data.beforeAmount === "number" ? data.beforeAmount : undefined,
        afterAmount:
          typeof data.afterAmount === "number" ? data.afterAmount : undefined,
        calls: typeof data.calls === "number" ? data.calls : undefined,
        stage: typeof data.stage === "string" ? data.stage : undefined,
      });
      const traceCompaction = (
        event: string,
        data: Record<string, unknown>,
      ) => {
        if (event === "context.compaction_started") {
          compactionSpan = this.traces.startSpan(task.id, {
            name: "context.compaction",
            category: "context",
            track: "Main thread",
            parentSpanId: contextTraceParent?.id,
            attributes: compactionAttributes(data),
          });
        } else if (event === "context.compaction_completed") {
          this.traces.endSpan(compactionSpan, "ok", compactionAttributes(data));
          compactionSpan = undefined;
        } else if (event === "context.compaction_failed") {
          this.traces.endSpan(
            compactionSpan,
            "error",
            compactionAttributes(data),
          );
          compactionSpan = undefined;
        }
      };

      const context = new ContextManager({
        store: this.store,
        sessionId: session.id,
        model: settings.model,
        limit: budget.limit,
        currentFileHash: (file) => runner.currentFileHash(file),
        measure: budget.measure,
        measurement: budget.measurement,
        unit: budget.unit,
        maxOutputTokens: budget.outputTokens,
        onModelRequest: () =>
          emit("model_request", { purpose: "compaction", step }),
        onUsage: (usage) => recordUsage(usage, "compaction"),
        provider: tracedModelProvider(
          this.replayProvider(task, provider, () => ({
            purpose: "compaction",
            step,
          })),
          this.traces,
          {
            taskId: task.id,
            purpose: "compaction",
            model: settings.model,
            step,
            parentSpanId: () => contextTrace.currentSpanId?.(),
          },
        ),
        summaryModel: settings.auxiliaryModel
          ? async () => {
              const selected = auxiliarySettings(settings);
              const auxiliary =
                this.factory?.(selected, "auxiliary") ??
                new ResponsesProvider(selected, this.config.apiKey);
              let metadata: ModelCapabilities | undefined;
              try {
                metadata = await auxiliary.getCapabilities?.(signal);
              } catch (error) {
                signal.throwIfAborted();
                log.warn({
                  event: "model.capabilities_unavailable",
                  purpose: "compaction",
                  err: error,
                });
              }

              const summaryBudget = createBudget(
                metadata,
                settings.contextChars,
                settings.maxOutputTokens,
              );
              log.info({
                event: "context.summary_model_selected",
                model: selected.model,
                unit: summaryBudget.unit,
                inputLimit: summaryBudget.limit,
              });

              return {
                provider: tracedModelProvider(
                  this.replayProvider(task, auxiliary, () => ({
                    purpose: "compaction",
                    step,
                  })),
                  this.traces,
                  {
                    taskId: task.id,
                    purpose: "compaction",
                    model: selected.model,
                    step,
                    parentSpanId: () => contextTrace.currentSpanId?.(),
                  },
                ),
                model: selected.model,
                budget: summaryBudget,
              };
            }
          : undefined,
        signal,
        clean: (text) => redactJson(text, [this.config.apiKey]),
        notice: (text) => emit("notice", { text }),
        trace: contextTrace,
        report: (event, data) => {
          traceCompaction(event, data);
          log[event.endsWith("failed") ? "warn" : "info"]({
            event,
            unit: budget.unit,
            ...data,
          });
        },
      });
      const prepareContext = async (force = false) => {
        const contextSpan = this.traces.startSpan(task.id, {
          name: "context.prepare",
          category: "context",
          track: "Main thread",
          attributes: { force, step },
        });
        contextTraceParent = contextSpan;
        try {
          const prepared = await context.prepare(
            input,
            instructions,
            tools,
            force,
          );
          this.traces.endSpan(contextSpan, "ok", {
            inputItems: prepared.length,
          });

          return prepared;
        } catch (error) {
          const traceStatus = signal.aborted ? "cancelled" : "error";
          this.traces.endSpan(compactionSpan, traceStatus);
          compactionSpan = undefined;
          this.traces.endSpan(contextSpan, traceStatus, {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          throw error;
        } finally {
          if (contextTraceParent === contextSpan) {
            contextTraceParent = undefined;
          }
        }
      };

      let requestInput = input;
      let retryDelaySpan: ReturnType<TraceRecorder["startSpan"]>;
      const outcome = await runModelLoop({
        maxSteps: settings.maxSteps,
        signal,
        prepareStep: async (currentStep) => {
          step = currentStep;
          input = await prepareContext();
          lastFlush = Date.now();
          log.debug({ event: "model.started", step });
          requestInput = input;
          retryDelaySpan = undefined;
        },
        request: async (currentAttempt) => {
          attempt = currentAttempt;
          this.traces.endSpan(retryDelaySpan, "ok", { attempt });
          retryDelaySpan = undefined;

          const requestSpan = this.traces.startSpan(task.id, {
            name: "context.request",
            category: "context",
            track: "Main thread",
            attributes: { attempt, step },
          });
          let request;
          contextTraceParent = requestSpan;
          try {
            request = context.request(input, instructions, tools);
            requestInput = request.input;
            this.traces.endSpan(requestSpan, "ok", {
              afterAmount: request.after,
              beforeAmount: request.before,
              inputItems: request.input.length,
            });
          } catch (error) {
            this.traces.endSpan(
              requestSpan,
              signal.aborted ? "cancelled" : "error",
              {
                errorName: error instanceof Error ? error.name : typeof error,
              },
            );
            throw error;
          } finally {
            if (contextTraceParent === requestSpan) {
              contextTraceParent = undefined;
            }
          }

          emit("model_request", { purpose: "task", step, attempt });

          return tracedModelProvider(
            this.replayProvider(task, provider, () => ({
              purpose: "task",
              step,
              attempt,
            })),
            this.traces,
            {
              taskId: task.id,
              purpose: "task",
              model: settings.model,
              step,
              attempt,
            },
          ).run(
            requestInput,
            instructions,
            tools,
            signal,
            (delta) => {
              buffer += delta;
              if (Date.now() - lastFlush > 100 || buffer.length > 1000) {
                flush();
              }
            },
            { maxOutputTokens: budget.outputTokens },
          );
        },
        onRetry: (error, failedAttempt, delayMs) => {
          flush();
          emit("notice", {
            text: `${error.message} ${delayMs} ms 后重试（${failedAttempt}/2）。`,
            code: error.code,
            step,
            attempt,
          });
          retryDelaySpan = this.traces.startSpan(task.id, {
            name: "llm.retry_delay",
            category: "llm",
            track: "Main thread",
            attributes: {
              delayMs,
              failedAttempt,
              step,
            },
          });
          log.warn({
            event: "model.retry",
            step,
            attempt,
            delayMs,
            code: error.code,
            status: error.status,
            requestId: error.requestId
              ? redactText(error.requestId, [this.config.apiKey])
              : undefined,
            err: error,
          });
        },
        prepareOverflow: async () => {
          // 失败前收到的文本留在原 attempt 中，不能和下一次请求的回复拼在一起。
          flush();
          lastFlush = Date.now();
          input = await prepareContext(true);
        },
        acceptResponse: (response, calls) => {
          const responseSpan = this.traces.startSpan(task.id, {
            name: "model.response_process",
            category: "agent",
            track: "Main thread",
            attributes: { attempt, step },
          });
          try {
            flush();
            signal.throwIfAborted();
            if (response.usage) {
              budget.observeUsage?.(
                response.usage.input_tokens,
                requestInput,
                instructions,
                tools,
              );
              recordUsage(response.usage, "task");
            }

            input.push(...response.output);
            this.store.saveContext(session.id, input);
            if (response.text) {
              emit("assistant", { text: response.text, step, attempt });
            }

            this.traces.endSpan(responseSpan, "ok", {
              outputItems: response.output.length,
              toolCalls: calls.length,
            });
          } catch (error) {
            this.traces.endSpan(
              responseSpan,
              signal.aborted ? "cancelled" : "error",
              {
                errorName: error instanceof Error ? error.name : typeof error,
              },
            );
            throw error;
          }

          log.info({ event: "model.completed", step, toolCount: calls.length });
        },
        executeTools: async (calls) => {
          const batchId = randomUUID();
          const modelSpan = this.traces.latestSpan(task.id, "llm");
          const saveResult = (
            node: ToolGraphNode,
            result: any,
            executionStartedAt?: number,
          ) => {
            let output = JSON.stringify(result);
            const completeOutput = output.length <= settings.outputChars;

            if (!completeOutput) {
              output = JSON.stringify({
                truncated: true,
                text: output.slice(0, settings.outputChars),
              });
            }

            output = redactJson(output, [this.config.apiKey]);
            const durationMs =
              executionStartedAt === undefined
                ? 0
                : Date.now() - executionStartedAt;
            const persistenceSpan = this.traces.startSpan(task.id, {
              name: "tool.result_persist",
              category: "storage",
              track: "Main thread",
              attributes: {
                batchId,
                callId: node.callId,
                nodeId: node.nodeId,
              },
            });
            // 工具副作用无法由 SQLite 回滚；每个并行节点完成后立即原子保存结果和模型反馈。
            try {
              const persistResult = () => {
                emit("tool_result", {
                  name: node.name,
                  callId: node.callId,
                  batchId,
                  nodeId: node.nodeId,
                  dependsOn: node.dependsOn,
                  result: JSON.parse(output),
                  durationMs,
                });
                // replay 保留执行器原始脱敏结果，不受模型上下文 outputChars 截断影响。
                this.store.finishReplayTool(
                  task.id,
                  node.callId,
                  cleanReplay(result),
                );
                input.push({
                  type: "function_call_output",
                  call_id: node.callId,
                  output,
                });
                this.store.saveContext(session.id, input);
              };

              const subagentRequest =
                node.name === "subagent"
                  ? (node.arguments as { request?: SubagentAction }).request
                  : undefined;
              if (
                subagentRequest?.action === "collect" &&
                !result?.error &&
                result?.reports &&
                completeOutput
              ) {
                this.store.commitSubagentCollect(
                  task.id,
                  subagentRequest.subagentIds,
                  persistResult,
                );
              } else {
                this.store.transaction(persistResult);
              }

              this.traces.endSpan(persistenceSpan, "ok", {
                outputChars: output.length,
              });
            } catch (error) {
              this.traces.endSpan(persistenceSpan, "error", {
                errorName: error instanceof Error ? error.name : typeof error,
              });
              throw error;
            }

            log.info({
              event: "tool.completed",
              tool: node.name,
              toolCallId: node.callId,
              nodeId: node.nodeId,
              batchId,
              durationMs,
              ok: toolSucceeded(result),
            });
          };

          const planningSpan = this.traces.startSpan(task.id, {
            name: "tool.plan",
            category: "tool",
            track: "Main thread",
            attributes: { batchId, calls: calls.length, step },
          });
          let graph;

          try {
            graph = buildModelToolGraph(calls, {
              exclusivePush: false,
              subagentsEnabled: task.subagentsEnabled,
            });
          } catch (error: any) {
            this.traces.endSpan(planningSpan, "error", {
              errorName: error instanceof Error ? error.name : typeof error,
            });
            const message = redactText(error.message, [this.config.apiKey]);
            // 图不可验证时整批没有副作用；每个原生调用都得到结果，模型可在下一轮修正计划。
            for (const [ordinal, call] of calls.entries()) {
              const node: ToolGraphNode = {
                callId: call.call_id,
                nodeId: `invalid-${ordinal + 1}`,
                name: call.name,
                arguments: call.arguments,
                dependsOn: [],
                ordinal,
              };
              emit("tool_start", {
                name: node.name,
                callId: node.callId,
                batchId,
                nodeId: node.nodeId,
                dependsOn: node.dependsOn,
                args: node.arguments,
              });
              this.store.startReplayTool(
                task.id,
                cleanReplay({
                  name: node.name,
                  callId: node.callId,
                  batchId,
                  nodeId: node.nodeId,
                  dependsOn: node.dependsOn,
                  arguments: node.arguments,
                }),
              );
              saveResult(node, { error: `工具调用图无效：${message}` });
            }

            return "invalid";
          }

          emit("tool_batch_planned", {
            batchId,
            nodes: graph.nodes.map((node) => ({
              callId: node.callId,
              nodeId: node.nodeId,
              name: node.name,
              dependsOn: node.dependsOn,
              ordinal: node.ordinal,
            })),
          });
          for (const node of graph.nodes) {
            emit("tool_start", {
              name: node.name,
              callId: node.callId,
              batchId,
              nodeId: node.nodeId,
              dependsOn: node.dependsOn,
              args:
                node.name === "memory_apply"
                  ? {
                      operationCount:
                        (node.arguments as { operations?: unknown[] })
                          .operations?.length ?? 0,
                    }
                  : node.arguments,
            });
            this.store.startReplayTool(
              task.id,
              cleanReplay({
                name: node.name,
                callId: node.callId,
                batchId,
                nodeId: node.nodeId,
                dependsOn: node.dependsOn,
                arguments: node.arguments,
              }),
            );
          }

          this.traces.endSpan(planningSpan, "ok", {
            nodes: graph.nodes.length,
          });

          const traceToolParameters = (arguments_: unknown) =>
            JSON.parse(
              redactJson(JSON.stringify(arguments_), [this.config.apiKey]),
            );

          const batchSpan = this.traces.startSpan(task.id, {
            name: "tool.batch",
            category: "tool",
            track: "Tool scheduler",
            attributes: {
              batchId,
              lanes: Math.min(graph.nodes.length, DEFAULT_TOOL_CONCURRENCY),
              nodes: graph.nodes.length,
              step,
            },
          });
          try {
            await executeToolGraph(graph, {
              execute: async (node, acquireExecutionSlot) => {
                signal.throwIfAborted();
                let slot: number | undefined;
                let executionStartedAt: number | undefined;
                let toolSpan: ReturnType<TraceRecorder["startSpan"]>;
                let result: any;

                const startExecution = async () => {
                  slot ??= await acquireExecutionSlot();
                  executionStartedAt = Date.now();
                  toolSpan = this.traces.startSpan(task.id, {
                    name:
                      node.name === "memory_apply"
                        ? "memory.apply"
                        : node.name === historyDefinition.name
                          ? "tool.read_context_history"
                          : `tool.${node.name}`,
                    category: node.name === "memory_apply" ? "memory" : "tool",
                    track: `Tool worker ${slot + 1}`,
                    attributes: {
                      batchId,
                      callId: node.callId,
                      nodeId: node.nodeId,
                      parameters:
                        node.name === "memory_apply" || node.name === "subagent"
                          ? undefined
                          : traceToolParameters(node.arguments),
                    },
                  });
                };

                try {
                  if (node.name === "subagent") {
                    if (!task.subagentsEnabled || !subagents) {
                      throw new Error("当前任务未开启 subagent。");
                    }

                    const action = (
                      node.arguments as { request?: SubagentAction }
                    ).request;
                    if (!action) {
                      throw new Error("subagent 缺少结构化操作。");
                    }

                    if (action.action !== "await") {
                      await startExecution();
                    }

                    result = await subagents.execute(action);
                    if (action.action === "await") {
                      await startExecution();
                    }
                  } else if (node.name === historyDefinition.name) {
                    await startExecution();
                    result = await readContextHistoryAsync(
                      this.store,
                      session.id,
                      node.arguments,
                      settings.outputChars,
                    );
                  } else {
                    result = await runner
                      .forCall(node.callId)
                      .execute(node.name, node.arguments, startExecution);
                  }
                } catch (error: any) {
                  if (signal.aborted) {
                    throw error;
                  }

                  result = {
                    error: redactText(error.message, [this.config.apiKey]),
                  };
                  log.warn({
                    event: "tool.failed",
                    tool: node.name,
                    toolCallId: node.callId,
                    nodeId: node.nodeId,
                    batchId,
                    err: error,
                  });
                }

                // 只记录匹配策略的计数；源码、oldText 和替换内容不进入 trace。
                const editMatchModes: string[] =
                  node.name === "edit_files" && Array.isArray(result?.files)
                    ? result.files.flatMap((file: any) =>
                        Array.isArray(file.matchModes) ? file.matchModes : [],
                      )
                    : [];
                this.traces.link(modelSpan, toolSpan, "llm_to_tool");
                this.traces.endSpan(
                  toolSpan,
                  toolSucceeded(result) ? "ok" : "error",
                  {
                    durationMs: executionStartedAt
                      ? Date.now() - executionStartedAt
                      : 0,
                    editExactMatches:
                      node.name === "edit_files"
                        ? editMatchModes.filter((mode) => mode === "exact")
                            .length
                        : undefined,
                    editLineEndingMatches:
                      node.name === "edit_files"
                        ? editMatchModes.filter(
                            (mode) => mode === "normalized_line_endings",
                          ).length
                        : undefined,
                    editWhitespaceMatches:
                      node.name === "edit_files"
                        ? editMatchModes.filter(
                            (mode) => mode === "normalized_whitespace",
                          ).length
                        : undefined,
                  },
                );
                saveResult(node, result, executionStartedAt);

                return toolSucceeded(result);
              },
              block: async (node, failedDependency) => {
                this.traces.instant(
                  task.id,
                  "tool.dependency_blocked",
                  "tool",
                  "Tool scheduler",
                  {
                    batchId,
                    callId: node.callId,
                    nodeId: node.nodeId,
                    failedDependency: failedDependency.nodeId,
                  },
                );
                saveResult(node, {
                  error: `依赖工具 ${failedDependency.nodeId} 未成功，未执行当前调用。`,
                  code: "dependency_failed",
                  failedDependency: failedDependency.nodeId,
                });
              },
              state: (node, state) =>
                emit("tool_state", {
                  batchId,
                  nodeId: node.nodeId,
                  callId: node.callId,
                  state,
                }),
            });
            this.traces.endSpan(batchSpan, "ok");
          } catch (error) {
            this.traces.endSpan(
              batchSpan,
              signal.aborted ? "cancelled" : "error",
            );
            throw error;
          }

          return "executed";
        },
      });
      if (outcome !== "completed") {
        throw new Error("已达到最大模型调用次数，任务停止。");
      }
    } catch (error: any) {
      flush();
      status = signal.aborted
        ? signal.reason?.message?.startsWith("服务关闭")
          ? "interrupted"
          : "cancelled"
        : "failed";
      failure = signal.aborted
        ? status === "interrupted"
          ? "服务关闭，任务中断，可手动恢复。"
          : "任务已取消，可手动恢复。"
        : redactText(String(error?.message || "任务失败").slice(0, 2000), [
            this.config.apiKey,
          ]);
      emit("notice", { text: failure, status });
      log[status === "failed" ? "error" : "info"]({
        event: "task." + status,
        code: error?.code,
        message: failure,
        ...(status === "failed" ? { err: error } : {}),
      });
    } finally {
      try {
        await subagents?.close();
      } catch (error) {
        status = "failed";
        failure = "subagent 退出或状态落盘失败，任务结果不能视为完成。";
        log.error({ event: "subagent.cleanup_failed", err: error });
      }

      this.store.status(task.id, status, failure);
      try {
        this.store.finishReplayCapture(task.id, status);
        this.traces.endSpan(replayCaptureSpan, "ok");
      } catch (error) {
        this.traces.endSpan(replayCaptureSpan, "error", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        log.error({ event: "replay.capture_failed", err: error });
      }

      this.traces.finishTask(
        task.id,
        status === "completed"
          ? "ok"
          : status === "cancelled" || status === "interrupted"
            ? "cancelled"
            : "error",
      );
      const trace = this.traces.exportTask(task.id);
      if (trace) {
        await this.traceArchive.write(task.sessionId, task.id, trace);
      }

      this.traces.discardTask(task.id);
      this.sandbox.releaseTask(task.id);

      emit("task_end", { status });
      log.info({ event: "task.finished", status });
    }
  }
}
