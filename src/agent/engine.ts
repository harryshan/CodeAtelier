/**
 * CodeAtelier 的任务执行入口，把模型请求、工具调用 DAG、审批和历史保存串起来。
 * HTTP 服务和手动评测都会创建 Engine；任务记录写入 Store，界面通过事件获知变化。
 *
 * 0. toolReviewer/processReviewer 绑定主模型的独立状态检查，供进程与 MCP 每五分钟使用；usage/replay/trace 按 callId 关联，不追加主对话或重放执行。
 * 1. 构造器接好审批通知；手动评测可仅对宿主模型循环覆盖步数阈值，snapshot 读取会话状态，emit 脱敏并保存事件。
 * 2. start 原子保存用户消息和任务级 subagent 选择为 queued；多 agent 尚未就绪时拒绝开启。调度器在全局并发上限内启动不同工作区的任务，并对相同真实工作区保持互斥。
 * 3. resume 继续最后一个可恢复任务；cancel 处理用户取消，close 处理服务关闭及 Worktree 管理取消。托管 checkout 在 admission/run/Runtime 启动前核验；快照补充来源清单，记忆映射来源而工具保留实际根。
 * 4. createModelProvider 按主/辅助协议和密钥创建客户端；主/子任务按协议裁剪搜索，Responses 由宿主/Broker 绑定稳定 cache key 后进入 tracing/Replay；子模型继承任务输出上限和已知容量约束，捕获同时保存可信 subagentId/subagentRequestId。
 *    摘要请求按服务容量独立预算，不受主任务手动窗口限制；首条 prompt 先用辅助模型生成标题；run 再读取历史和项目规则，准备工具及上下文预算；首次压缩检查前恢复会话 token 锚点，响应保存后更新锚点，Runtime 经 Broker 共用持久化。
 * 5. model-loop 共用轮次、重试和停止控制，model-response 共用响应接收顺序，dispatch-model-tool 共用节点分派，model-tool-batch 共用计划、结果截断与成功判断；Engine 保留宿主事务、replay 与 tracing。为压缩提供 ToolRunner 的安全文件哈希探测；每轮记录上下文准备和请求计量、模型重试、实际模型请求和响应处理，再记录服务实报用量。完整响应保存后校验工具 DAG，节点先完成准备/审批，实际执行才取得有界 worker 槽。
 * 6. Windows/MXC Runtime 通过共同 launcher/IPC 接入；实例 mode 与 pidKind 保留平台真实归因。Sandbox Runtime 已有能力内工具免审批；run_with_permissions 的获批命令交给 Broker 宿主进程并留下未隔离的执行记录，Git CLI 使用相同命令路径。一次性两阶段 IPC 授权把命令审批等待留在执行队列外；独立 Push/Capability Runner 实现已删除，旧 kind 仅供历史回读。
 *    项目记忆每任务提供当前项目全部有效条目的 ID/摘要，宿主/Runtime/fallback 共用无查询参数的目录读取，正文按需获取。
 *    Skill 每任务在 Broker 扫描预设目录，模型先看到摘要、工具按需加载正文；宿主/Runtime/fallback 共用该目录且不授权脚本。
 *    MCP 在首次模型请求前提供已启用服务的公开用途摘要，不提前连接；任务级本机连接池由宿主/Runtime 共用审批后单次执行入口，收尾关闭，摘要、参数和正文不进入 trace。
 * 7. Agent Runtime 取消先经 IPC 等待 runtime_complete/stopping，再关闭原生 transport；清理未知优先于取消。终态保留已验证进程身份；Broker 校验 Runtime trace 时间戳，按该进程的执行槽组织片段、从已保存工具调用附加脱敏参数并统一归档，在结果持久化前按对应执行片段补齐耗时；子任务由 Broker 核对身份与原子保存问题回执，退出先停子线程再归档。
 * 8. run 的终态持久化与 trace 收尾分开保护；写库失败仍尝试归档失败 trace，导出/归档故障只记警告，最外层 finally 释放 trace 内存和任务级 Sandbox 状态。
 *
 * 模型请求可以重试，但已经执行的工具不能跟着重跑。数据库回滚也撤销不了文件修改或
 * 已启动的命令，所以保存失败时必须停止任务，并留下足够的记录供后续恢复。
 * 诊断生命周期：从入队建立 trace，精确关联模型/工具/持久化；关闭时等待检查点与终态归档，SSE 和快照只记录安全游标。
 */

import { TaskSkills } from "../skills/task-skills.js";
import { McpTaskClient } from "../mcp/task-client.js";
import { mcpCatalogInstructions } from "../mcp/catalog.js";
import type { McpAction } from "../mcp/contracts.js";
import { auxiliarySettings } from "../config/auxiliary-model.js";
import type { Settings } from "../shared/types.js";
import { tokenScope } from "../context/token-anchor.js";
import { SessionTokenCalibration } from "../context/session-token-calibration.js";
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
import { SUBAGENT_PUBLIC_READY } from "./subagent-readiness.js";
import {
  subagentToolDefinition,
  type SubagentAction,
} from "./subagent-contracts.js";
import { createInstructions } from "./instructions.js";
import { runModelLoop } from "./model-loop.js";
import { acceptModelResponse } from "./model-response.js";
import { dispatchModelTool } from "../tools/dispatch-model-tool.js";
import {
  buildModelToolGraph,
  serializeToolOutput,
  toolSucceeded,
} from "../tools/model-tool-batch.js";
import { retryModel } from "../providers/retry.js";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { SessionStore } from "../sessions/async-store.js";
import { generateConversationTitle } from "../sessions/title-generator.js";
import { Config } from "../config/config.js";
import { ApprovalManager } from "../permissions/approval-manager.js";
import {
  assessApproval,
  type ApprovalAssessment,
  type ApprovalSubject,
} from "../permissions/model-approval.js";
import { createModelProvider } from "../providers/create-provider.js";
import { withPromptCacheKey } from "../providers/prompt-cache.js";
import { protocolFeatures } from "../providers/protocol.js";
import {
  type ModelProvider,
  type ModelProviderFactory,
} from "../providers/model-provider.js";
import {
  captureModelProvider,
  replaySettings,
  type RecordedModelExchange,
} from "../sessions/replay-case.js";
import { createToolReviewer } from "./tool-review.js";
import type { ToolReviewSubject } from "../tools/long-tool-monitor.js";
import { ToolRunner } from "../tools/tool-runner.js";
import { SubagentReadOnly } from "../tools/subagent-readonly.js";
import { ProjectMemoryService } from "../memory/service.js";
import { WorktreeService } from "../worktrees/service.js";
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
import { withTraceContext } from "../tracing/context.js";
import { TraceTaskMonitor } from "../tracing/task-monitor.js";
import { tracedModelProvider } from "../tracing/model-provider.js";
import { TraceArchive } from "../tracing/archive.js";
import { TraceRecorder } from "../tracing/recorder.js";
import type {
  ReadFileTrace,
  ReadFileTraceStage,
} from "../tools/read-file-content.js";
import type { TraceSpan } from "../tracing/types.js";
import type { Task, TaskStatus } from "../shared/types.js";
import type { AgentRuntimeLauncher } from "../sandbox/agent-runtime-launcher.js";
import { AgentRuntimeFallbackError } from "../sandbox/agent-runtime-launcher.js";
import {
  RuntimeBrokerGateway,
  type RuntimeExecutionIdentity,
} from "../sandbox/runtime-capability-core.js";
import { RuntimeIpcBrokerSession } from "../sandbox/runtime-ipc-broker-session.js";
import { commandShell } from "../tools/command-shell.js";
import { executeProcess } from "../tools/process.js";
import type {
  CapabilityCommandRequest,
  CapabilityCommandResult,
} from "../sandbox/capability-request.js";
import type {
  ExecutionInstanceRecord,
  ExecutionInstanceState,
  SandboxStatus,
} from "../sandbox/types.js";

// 标题请求没有工具或文件副作用；服务未提供可分类原因时，允许比主任务多一次诊断性重试。
const titleRetryOptions = { retries: 3, retryUnknownErrors: true };

class AgentRuntimeCleanupUnknownError extends Error {
  readonly code = "SANDBOX_RUNTIME_CLEANUP_UNKNOWN";

  constructor(cause?: unknown) {
    super(
      "Agent Runtime 结果或清理状态未知，平台启动器必须隔离并核对残留实例。",
      {
        cause,
      },
    );
    this.name = "AgentRuntimeCleanupUnknownError";
  }
}

type ModelUsagePurpose =
  "task" | "compaction" | "title" | "approval" | "subagent" | "tool_review";

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
  private cancellingTasks = new Set<string>();
  private approvalTasks = new WeakMap<ApprovalSubject, Task>();
  private closing = false;
  private readonly mcpTasks = new Map<string, McpTaskClient>();
  /** 领取任务时固定连接/凭据；标题、审批、摘要、复查和 Runtime 代理禁止回读全局连接。 */
  private readonly taskConfigs = new Map<
    string,
    ReturnType<Config["taskSnapshot"]>
  >();

  private taskConfig(taskId: string) {
    const snapshot = this.taskConfigs.get(taskId);
    if (!snapshot) {
      throw new Error("任务配置快照缺失，拒绝使用全局连接替代。");
    }

    return snapshot;
  }

  settingsChanged() {
    return this.schedule();
  }

  private schedulingWork?: Promise<void>;
  private schedulingRequested = false;
  /** 全部宿主任务共享 Worker 配额；Sandbox Runtime 另须通过 Broker 取得同一全局 lease。 */
  private readonly subagentLimits = new SubagentLimits();
  /** 当前进程仅保留运行中任务构造 trace 所需的状态，任务落盘后立即释放。 */
  readonly traces: TraceRecorder;
  private readonly workerTasks = new Set<string>();
  private readonly persistenceErrors = new Map<string, Error>();
  /** 已结束任务的 trace 另行按会话/任务写入数据目录，服务重启后仍可下载。 */
  readonly traceArchive: TraceArchive;
  private readonly traceTasks: TraceTaskMonitor;
  /** SandboxBroker 在任务内固定安全 fallback；执行已开始后的未知结果仍不会重放。 */
  readonly sandbox: SandboxBroker;
  /** Sandbox 安装、自检、Runtime、Broker 和 fallback 生命周期写入独立 sandbox.log。 */
  readonly sandboxLog: Logger;
  /** 项目记忆只写入平台数据目录；任务开始时读取固定 bundle，工具调用时执行受限维护操作。 */
  readonly memories: ProjectMemoryService;
  /** 管理清单与实际工作区绑定；不改变 Store 的 workspace 或调度键。 */
  readonly worktrees: WorktreeService;

  /** 主模型独立审视在途工具；不追加未完成的 function_call_output，也不计为主循环轮次。 */
  private async toolReviewer(task: Task, settings: Settings) {
    const prompt =
      (
        (await this.store.taskEvent(task.id, "user")) as
          { text?: string } | undefined
      )?.text ?? "";

    return createToolReviewer({
      provider: (subject) => {
        // 只在真正检查时创建 provider；普通短工具不能引入额外模型初始化。
        const provider =
          this.factory?.(settings, "task") ??
          createModelProvider(settings, this.taskConfig(task.id).modelKey());

        return tracedModelProvider(
          this.replayProvider(task, provider, () => ({
            purpose: "tool_review",
          })),
          this.traces,
          {
            taskId: task.id,
            purpose: "tool_review",
            model: settings.model,
            callId: subject.callId,
          },
        );
      },
      prompt,
      secrets: this.config.errorSecrets(),
      emit: (type, data) => {
        this.emit(task, type, data);
        this.log.info({
          event: "tool.review",
          taskId: task.id,
          sessionId: task.sessionId,
          callId: data.callId,
          phase: type,
          action: data.action,
          reviewFailed: data.reviewFailed,
        });
        if (type === "notice") {
          this.traces.instant(
            task.id,
            "tool.review_decision",
            "tool",
            "Main thread",
            {
              callId: data.callId,
              action: data.action,
              reviewFailed: data.reviewFailed,
            },
          );
        }
      },
    });
  }

  private processReviewer(
    task: Task,
    settings: Settings,
    subject: ToolReviewSubject,
  ) {
    return async (
      status: Parameters<Awaited<ReturnType<Engine["toolReviewer"]>>>[1],
      signal: AbortSignal,
    ) => (await this.toolReviewer(task, settings))(subject, status, signal);
  }

  private prepareMcp(
    task: Task,
    workspace: string,
    request: McpAction,
    toolCallId: string,
    signal: AbortSignal,
    outputChars: number,
  ) {
    let client = this.mcpTasks.get(task.id);
    if (!client) {
      client = new McpTaskClient({
        servers: this.taskConfig(task.id).mcpServers,
        workspace,
        taskId: task.id,
        sessionId: task.sessionId,
        outputChars,
        reviewTool: async (subject, status, signal) =>
          (await this.toolReviewer(task, this.taskConfig(task.id).settings))(
            subject,
            status,
            signal,
          ),
        log: this.log,
        traces: this.traces,
        approve: (description, approvalSignal) =>
          this.approvals.request(
            {
              sessionId: task.sessionId,
              taskId: task.id,
              tool: "mcp",
              description,
            },
            approvalSignal,
          ),
      });
      this.mcpTasks.set(task.id, client);
    }

    return client.prepare(request, toolCallId, signal);
  }

  /** 保留单任务调用方的兼容访问；服务端新逻辑应使用 activeTasks 或 hasActiveTasks。 */
  get active() {
    return this.activeByTaskId.values().next().value as ActiveTask | undefined;
  }

  get activeTasks() {
    return [...this.activeByTaskId.values()].map(({ task }) => task);
  }

  async hasActiveTasks() {
    return (
      this.activeByTaskId.size > 0 ||
      (await this.store.queuedTasks()).length > 0
    );
  }

  /** 下载只读取已经成功落盘的 trace，运行中或写入失败任务不会暴露不完整的内存数据。 */
  async savedTrace(task: Task) {
    return this.traceArchive.read(task.sessionId, task.id);
  }

  /** 运行中快照和崩溃前检查点始终标为 partial，不能据此认定任务完成。 */
  async liveTrace(task: Task) {
    const trace = this.traces.exportTask(task.id);
    if (trace) {
      return JSON.stringify({
        ...trace,
        metadata: { ...trace.metadata, partial: true },
      });
    }

    return this.traceArchive.readCheckpoint(task.sessionId, task.id);
  }

  traceRefresh(sessionId: string, eventId?: number) {
    for (const task of this.activeTasks) {
      if (task.sessionId === sessionId) {
        this.traces.instant(
          task.id,
          "session.sse_refresh",
          "http",
          "Session delivery",
          { eventId },
        );
      }
    }
  }

  constructor(
    public store: SessionStore,
    public config: Config,
    private log: Logger,
    private factory?: ModelProviderFactory,
    private agentRuntimeLauncher?: AgentRuntimeLauncher,
    private modelStepLimitOverride?: number | null,
  ) {
    this.traces = new TraceRecorder(config.tracing);
    this.traceArchive = new TraceArchive(
      config.directory,
      log,
      config.tracing.retentionDays,
    );
    this.traceTasks = new TraceTaskMonitor(
      this.traces,
      this.traceArchive,
      log,
      config.tracing.checkpointMs,
    );
    this.store.setTracer(this.traces);
    this.events.on(
      "event",
      (event: { taskId: string; id: number; type: string }) => {
        this.traces.instant(
          event.taskId,
          "session.event_committed",
          "storage",
          "Session delivery",
          { eventId: event.id, type: event.type },
        );
      },
    );
    this.sandboxLog = createSandboxLogger(
      config.directory,
      config.settings.logLevel,
      () => config.errorSecrets(),
    );
    this.sandbox = new SandboxBroker(
      config.sandbox,
      createSandboxRuntime(
        config.sandbox,
        process.platform,
        this.sandboxLog,
        this.traces,
        config.directory,
        config.startupEnvironment,
      ),
      this.sandboxLog,
      this.traces,
    );
    this.agentRuntimeLauncher ??= config.sandbox.enabled
      ? this.sandbox
      : undefined;
    this.worktrees = new WorktreeService(config.directory, log);
    this.memories = new ProjectMemoryService(
      config.directory,
      log,
      (workspace) => this.worktrees.projectWorkspace(workspace),
    );
    this.approvals = new ApprovalManager(
      () => this.updateWaitingTaskStatuses(),
      (subject, signal, context) =>
        this.classifyApproval(subject, signal, context),
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
      this.traces,
    );
  }

  /** 审批始终优先使用显式配置的低成本模型；缺失、取消以外的故障不能自动放行。 */
  private async classifyApproval(
    subject: ApprovalSubject,
    signal: AbortSignal,
    context: { sessionId: string; taskId: string },
  ): Promise<ApprovalAssessment> {
    // Runtime IPC 可能提供独立的取消信号；会话路径只从后端存储读取，不采信待审批命令。
    const active =
      this.activeForSignal(signal) ?? this.activeByTaskId.get(context.taskId);
    const task =
      active?.task.sessionId === context.sessionId ? active.task : undefined;
    const workspaceRoot = (await this.store.get(context.sessionId))?.workspace;
    if (task) {
      this.approvalTasks.set(subject, task);
    }

    if (!workspaceRoot || !task) {
      return {
        decision: "human review",
        reason: "无法确认会话工作区，需要人工确认。",
      };
    }

    const settings = this.taskConfig(task.id).settings;
    if (!settings.auxiliaryModel?.trim()) {
      return {
        decision: "human review",
        reason: "未配置低成本审批模型，需要人工确认。",
      };
    }

    const selected = auxiliarySettings(settings);
    const provider =
      this.factory?.(selected, "approval") ??
      createModelProvider(selected, this.taskConfig(task.id).modelKey(true));

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
        workspaceRoot,
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
    const task = this.activeTasks.find((task) => task.sessionId === id);
    const span = this.traces.startSpan(task?.id ?? "", {
      name: "session.snapshot",
      category: "http",
      track: "Session delivery",
      attributes: { after },
    });
    try {
      const snapshot = await withTraceContext(this.traces, span, () =>
        this.store.snapshotPage(id, { after }),
      );

      return {
        ...snapshot,
        session: snapshot.session
          ? await this.worktrees.describe(snapshot.session)
          : undefined,
        approvals: this.approvals.list(id),
      };
    } catch (error) {
      this.traces.endSpan(span, "error");
      throw error;
    } finally {
      this.traces.endSpan(span, "ok");
    }
  }

  private emit(task: Task, type: string, data: any) {
    this.traces.relations.event(task.id, type, data);
    const clean = JSON.parse(
      redactJson(JSON.stringify(data), this.config.errorSecrets()),
    );
    void this.store.eventAsync(task.sessionId, task.id, type, clean).then(
      (event) => {
        this.events.emit("event", event);
        this.events.emit("change", task.sessionId);
      },
      (error: Error) => this.persistenceErrors.set(task.id, error),
    );
  }

  private async drainEvents(taskId: string) {
    await this.store.drain();
    const error = this.persistenceErrors.get(taskId);
    if (error) {
      this.persistenceErrors.delete(taskId);
      throw error;
    }
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
    details: () => Pick<
      RecordedModelExchange,
      "purpose" | "step" | "attempt" | "subagentId" | "subagentRequestId"
    >,
  ) {
    const clean = <T>(value: T) =>
      JSON.parse(
        redactJson(JSON.stringify(value), this.config.errorSecrets()),
      ) as T;

    return captureModelProvider(
      provider,
      {
        startModelExchange: async (exchange) => {
          await this.drainEvents(task.id);
          await this.store.replayAsync(
            task.id,
            "modelStart",
            null,
            clean(exchange),
          );

          return exchange.id;
        },
        finishModelExchange: (id, outcome) =>
          this.store.replayAsync(task.id, "modelFinish", id, clean(outcome)),
      },
      details,
    );
  }

  start(sessionId: string, prompt: string, options: StartTaskOptions = {}) {
    return this.startAsync(sessionId, prompt, options);
  }

  async startAsync(
    sessionId: string,
    prompt: string,
    options: StartTaskOptions = {},
  ) {
    if (options.subagentsEnabled && !SUBAGENT_PUBLIC_READY) {
      throw new Error("subagent 尚未就绪，不能启用本次任务。");
    }

    if (this.closing) {
      throw new Error("服务正在关闭，不能启动任务。");
    }

    if (
      !this.config.settings.baseUrl ||
      !this.config.settings.model ||
      (!this.factory && !this.config.modelKey())
    ) {
      throw new Error("请先在设置中完成主模型连接与密钥配置。");
    }

    const session = await this.store.get(sessionId);
    if (session) {
      await this.worktrees.validate(session.workspace);
    }

    const { task, events } = await this.store.startTaskAsync(
      sessionId,
      prompt,
      options.subagentsEnabled ?? false,
      options.recovery,
    );
    for (const event of events) {
      this.events.emit("event", event);
    }

    this.traceTasks.submitted(task.id, task.sessionId);
    this.events.emit("change", sessionId);
    await this.schedule();
    await this.store.drain();

    return (await this.store.task(task.id))!;
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
      void this.store
        .statusAsync(active.task.id, waiting ? "waiting" : "running")
        .then(
          () => this.events.emit("change", active.task.sessionId),
          (error: Error) => this.persistenceErrors.set(active.task.id, error),
        );
    }
  }

  /** 在全局上限内领取不与已运行任务共享真实工作区的最早队列项；被工作区锁阻塞的项保持排队。 */
  private schedule(): Promise<void> {
    this.schedulingRequested = true;
    this.schedulingWork ??= (async () => {
      do {
        this.schedulingRequested = false;
        if (!this.closing) {
          await this.schedulePass();
        }
      } while (this.schedulingRequested && !this.closing);
    })().finally(() => {
      this.schedulingWork = undefined;
    });

    return this.schedulingWork;
  }

  private async schedulePass() {
    try {
      for (const candidate of await this.store.queuedTasks()) {
        this.traceTasks.submitted(candidate.id, candidate.sessionId);
        this.traceTasks.waiting(
          candidate.id,
          [...this.activeByTaskId.values()].some(
            (active) => active.workspace === candidate.workspace,
          )
            ? "workspace"
            : this.activeByTaskId.size >=
                this.config.settings.maxConcurrentTasks
              ? "capacity"
              : "ready",
        );
      }

      while (
        this.activeByTaskId.size < this.config.settings.maxConcurrentTasks
      ) {
        const next = (await this.store.queuedTasks()).find(
          (candidate) =>
            !this.cancellingTasks.has(candidate.id) &&
            ![...this.activeByTaskId.values()].some(
              (active) => active.workspace === candidate.workspace,
            ),
        );
        if (!next || this.closing) {
          return;
        }

        await this.launch(next);
      }
    } finally {
      for (const candidate of await this.store.queuedTasks()) {
        this.traceTasks.waiting(
          candidate.id,
          [...this.activeByTaskId.values()].some(
            (active) => active.workspace === candidate.workspace,
          )
            ? "workspace"
            : "capacity",
        );
      }
    }
  }

  /** 将已领取任务转为 running 后再启动异步循环，确保同工作区的后续任务看见锁。 */
  private async launch(queued: Task & { workspace: string }) {
    this.traceTasks.started(queued.id);
    const user = (await this.store.taskEvent(queued.id, "user")) as
      { text?: string } | undefined;
    // Metadata reads yield to cancellation. Recheck before publishing an active task.
    const current = await this.store.task(queued.id);
    if (
      this.cancellingTasks.has(queued.id) ||
      current?.status !== "queued" ||
      this.closing
    ) {
      return;
    }

    if (!user?.text) {
      await this.store.failTitleGeneration(queued.sessionId);
      await this.store.status(queued.id, "failed", "缺少任务描述，无法执行。");
      void this.traceTasks.finish(queued.id, queued.sessionId, "error");
      this.emit(queued, "task_end", { status: "failed" });
      this.events.emit("change", queued.sessionId);

      return;
    }

    const task = { ...queued, status: "running" as TaskStatus };
    const controller = new AbortController();
    const active: ActiveTask = {
      task,
      workspace: queued.workspace,
      controller,
      done: Promise.resolve(),
    };
    const snapshot = this.config.taskSnapshot();
    this.taskConfigs.set(task.id, snapshot);
    this.traces.configureTask(task.id, snapshot.tracing, snapshot.revision);
    this.activeByTaskId.set(task.id, active);
    const generateTitle =
      (await this.store.get(task.sessionId))?.titleState === "generating";

    this.workerTasks.add(task.id);
    active.done = this.store
      .statusAsync(task.id, "running")
      .then(async () =>
        withTraceContext(
          this.traces,
          this.traces.startTask(task.id, task.sessionId),
          async () =>
            this.run(
              (await this.store.task(task.id))!,
              user.text!,
              controller.signal,
              generateTitle,
            ),
        ),
      )
      .catch(async (error) => {
        this.log.error({
          event: "task.persistence_failed",
          module: "agent",
          taskId: task.id,
          err: error,
        });
        try {
          await this.store.statusAsync(
            task.id,
            "failed",
            "任务持久化异常，请检查存储空间和权限后恢复。",
          );
        } catch {
          /* 下次启动时会将未完成任务标为中断。 */
        }
      })
      .finally(async () => {
        if (this.traces.hasTask(task.id)) {
          await this.traceTasks.finish(task.id, task.sessionId, "error");
        }

        this.taskConfigs.delete(task.id);
        this.activeByTaskId.delete(task.id);
        this.workerTasks.delete(task.id);
        this.events.emit("change", task.sessionId);
        void this.schedule().catch((error) =>
          this.log.error({
            event: "task.schedule_failed",
            module: "agent",
            err: error,
          }),
        );
      });
    this.events.emit("change", task.sessionId);
  }

  async resume(id: string, instruction = "") {
    const request = await this.recoveryRequest(id, instruction);

    return this.start(request.sessionId, request.prompt, request.options);
  }

  async resumeAsync(id: string, instruction = "") {
    const request = await this.recoveryRequest(id, instruction);

    return this.startAsync(request.sessionId, request.prompt, request.options);
  }

  private async recoveryRequest(id: string, instruction: string) {
    const task = await this.store.task(id);

    if (
      !task ||
      !["failed", "cancelled", "interrupted"].includes(task.status)
    ) {
      throw new Error("该任务不可恢复。");
    }

    if ((await this.store.tasks(task.sessionId)).at(-1)?.id !== id) {
      throw new Error("只能恢复会话的最后一个任务；请在当前会话继续提问。");
    }

    const recovery = (await this.store.taskEvent(id, "recovery")) as
      { originalPrompt?: string } | undefined;
    const user = (await this.store.taskEvent(id, "user")) as
      { text?: string } | undefined;
    const prompt = recovery?.originalPrompt || user?.text;

    if (!prompt) {
      throw new Error("缺少原任务描述，请在当前会话重新说明任务。");
    }

    return {
      sessionId: task.sessionId,
      prompt:
        "恢复上次任务。原任务要求：\n" +
        prompt +
        "\n保留已完成的进度；先核实当前文件和不确定操作的状态，不要盲目重放命令。\n" +
        instruction,
      options: {
        subagentsEnabled: task.subagentsEnabled,
        recovery: { sourceTaskId: id, originalPrompt: prompt },
      },
    };
  }

  cancel(id: string) {
    return this.cancelAsync(id);
  }

  async cancelAsync(id: string) {
    this.cancellingTasks.add(id);
    try {
      await this.cancelTask(id);
    } finally {
      this.cancellingTasks.delete(id);
    }
  }

  private async cancelTask(id: string) {
    const active = this.activeByTaskId.get(id);
    if (active) {
      active.controller.abort();

      return;
    }

    const queued = await this.store.task(id);
    const launched = this.activeByTaskId.get(id);
    if (launched) {
      launched.controller.abort();

      return;
    }

    if (queued?.status !== "queued") {
      return;
    }

    const text = "任务已在队列中取消，可手动恢复。";
    await this.store.titleAsync(
      queued.sessionId,
      "failed",
      undefined,
      queued.id,
    );
    await this.store.statusAsync(id, "cancelled", text);
    const notice = await this.store.eventAsync(queued.sessionId, id, "notice", {
      text,
      status: "cancelled",
    });
    const end = await this.store.eventAsync(queued.sessionId, id, "task_end", {
      status: "cancelled",
    });
    this.events.emit("event", notice);
    this.events.emit("event", end);
    await this.traceTasks.finish(queued.id, queued.sessionId, "cancelled");
    this.events.emit("change", queued.sessionId);
    void this.schedule().catch((error) =>
      this.log.error({
        event: "task.schedule_failed",
        module: "agent",
        err: error,
      }),
    );
  }

  async close() {
    this.closing = true;
    try {
      await this.worktrees.close();
      await this.schedulingWork;
      for (const queued of await this.store.queuedTasks()) {
        const message = "服务关闭，任务中断，可手动恢复。";
        await this.store.titleAsync(
          queued.sessionId,
          "failed",
          undefined,
          queued.id,
        );
        await this.store.statusAsync(queued.id, "interrupted", message);
        const notice = await this.store.eventAsync(
          queued.sessionId,
          queued.id,
          "notice",
          { text: message, status: "interrupted" },
        );
        const end = await this.store.eventAsync(
          queued.sessionId,
          queued.id,
          "task_end",
          { status: "interrupted" },
        );
        this.events.emit("event", notice);
        this.events.emit("event", end);
        await this.traceTasks.finish(queued.id, queued.sessionId, "cancelled");
        this.events.emit("change", queued.sessionId);
      }

      const active = [...this.activeByTaskId.values()];
      for (const item of active) {
        item.controller.abort(new Error("服务关闭，任务中断，可手动恢复。"));
      }

      await Promise.all(active.map((item) => item.done));
      await this.traceTasks.drain();
      this.traceTasks.stop();
      await this.store.drain();
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
      createModelProvider(selected, this.taskConfig(task.id).modelKey(true));

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

      await this.store.titleAsync(task.sessionId, "completed", title, task.id);
      this.events.emit("change", task.sessionId);
      log.info({
        event: "session.title_generated",
        model: selected.model,
        titleLength: title.length,
      });
    } catch (error: any) {
      if (signal.aborted) {
        // 取消后的请求不会返回结果；结束标题状态，防止恢复任务永久卡在 generating。
        await this.store.titleAsync(
          task.sessionId,
          "failed",
          undefined,
          task.id,
        );
        this.events.emit("change", task.sessionId);
        throw signal.reason;
      }

      await this.store.titleAsync(task.sessionId, "failed", undefined, task.id);
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
    captureToolEvent: (type: string, data: any) => Promise<void>,
    runtimeToolCalls: Map<
      string,
      { name: string; args: unknown; batchId: string; nodeId: string }
    >,
    onLaunched: (pid: number) => void,
    skills: TaskSkills,
  ): Promise<{ status: TaskStatus; failure?: string }> {
    const launcher = this.agentRuntimeLauncher!;
    const runtimeContextSpans = new Map<string, TraceSpan | undefined>();
    const runtimeToolTracks = new Map<string, string>();
    const runtimeToolExecutions = new Map<string, TraceSpan>();
    const withRuntimeDuration = (data: any) => {
      const execution = runtimeToolExecutions.get(data.callId);
      // 使用 Runtime 已校验的单调时间，不把审批、执行槽排队或结果落盘耗时算作执行。
      // 没有开始片段表示未执行；有开始而无终态时不能伪造为 0 ms。
      const durationMs = !execution
        ? 0
        : execution.finishedAtUs === undefined
          ? undefined
          : Math.round(
              (execution.finishedAtUs - execution.startedAtUs) / 1_000,
            );
      runtimeToolExecutions.delete(data.callId);

      return { ...data, durationMs };
    };

    const executionInstanceId = randomUUID();
    const identity: RuntimeExecutionIdentity = {
      sessionId: task.sessionId,
      taskId: task.id,
      executionInstanceId,
      kind: "agent-runtime",
    };
    const requestedMode =
      process.platform === "linux"
        ? "linux-bubblewrap"
        : process.platform === "darwin"
          ? "macos-seatbelt"
          : "windows-sandbox-user";
    const nonce = randomBytes(32).toString("hex");
    let authorized = true;
    let launched:
      Awaited<ReturnType<AgentRuntimeLauncher["launch"]>> | undefined;
    let cleaned = false;
    let closeAttempted = false;
    let taskRequestStarted = false;
    let runtimeStoppedObserved = false;
    let runtimeError: unknown;
    let reported:
      | {
          status: TaskStatus;
          failure?: string;
        }
      | undefined;
    let broker: RuntimeIpcBrokerSession | undefined;
    const createdAt = new Date().toISOString();
    let processIdentity:
      | {
          pid: number;
          pidKind: "runtime" | "runtime-launcher";
          processCreationTime100ns?: string;
          accountGenerationDigest?: string;
        }
      | undefined;
    const runtimeSubagentIds = new Set<string>();
    const assertSubagentTask = async (candidate: RuntimeExecutionIdentity) => {
      const current = await this.store.task(task.id);
      if (
        !authorized ||
        candidate !== identity ||
        candidate.kind !== "agent-runtime" ||
        !current?.subagentsEnabled ||
        (current.status !== "running" && current.status !== "waiting")
      ) {
        throw new Error("Broker 子任务请求不属于当前活动任务与执行实例。");
      }
    };

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
        mode: launched?.mode ?? requestedMode,
        state,
        createdAt,
        updatedAt: new Date().toISOString(),
        sandboxRequested: true,
        sandboxApplied: launched !== undefined && state !== "created",
        // 终态是独立事件；不能让已验证的 PID 只存在于 running 事件中。
        ...processIdentity,
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
          gitWriteRoots: await this.worktrees.gitWriteRoots(workspace),
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

      onLaunched(launched.pid);
      processIdentity = {
        pid: launched.pid,
        pidKind: launched.pidKind ?? "runtime",
        processCreationTime100ns: launched.processCreationTime100ns,
        accountGenerationDigest: launched.accountGenerationDigest,
      };
      publishExecution("running");
      publishSandboxStage("executing");
      const gateway = new RuntimeBrokerGateway(
        {
          authorize: (candidate) => authorized && candidate === identity,
          getErrorSecrets: () => this.config.errorSecrets(),
          executionMode: launched.mode ?? requestedMode,
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
          modelProvider: (_runtime, purpose, request) => {
            const selected =
              purpose === "compaction" && settings.auxiliaryModel
                ? auxiliarySettings(settings)
                : settings;
            const provider =
              this.factory?.(
                selected,
                purpose === "compaction" ? "auxiliary" : "task",
              ) ??
              createModelProvider(
                selected,
                this.taskConfig(task.id).modelKey(purpose === "compaction"),
              );

            return {
              model: selected.model,
              provider: this.replayProvider(task, provider, () => ({
                purpose,
                ...(purpose === "subagent"
                  ? {
                      subagentId: request?.subagentId,
                      subagentRequestId: request?.subagentRequestId,
                    }
                  : {}),
              })),
            };
          },
        },
        this.traces,
        this.sandboxLog,
      );
      const currentBroker = new RuntimeIpcBrokerSession(
        { input: launched.input, output: launched.output },
        identity,
        nonce,
        gateway,
        {
          traces: this.traces,
          getErrorSecrets: () => this.config.errorSecrets(),
          subagentStore: async (candidate, request, requestSignal) => {
            await assertSubagentTask(candidate);
            switch (request.action) {
              case "plan":
                await Promise.all(
                  request.subtasks.map((plan) =>
                    SubagentReadOnly.create(
                      workspace,
                      plan.scope,
                      requestSignal,
                    ),
                  ),
                );
                requestSignal.throwIfAborted();

                const planned = await this.store.planSubagents(
                  task.id,
                  request.subtasks,
                );
                for (const child of planned) {
                  runtimeSubagentIds.add(child.id);
                }

                this.events.emit("change", task.sessionId);

                return planned;
              case "list":
                return await this.store.subagents(task.id);
              case "update": {
                const updated = await this.store.updateSubagent(
                  task.id,
                  request.subagentId,
                  request.status,
                  request.context,
                  request.report,
                );
                this.events.emit("change", task.sessionId);

                return updated;
              }

              case "question": {
                const receipt = await this.store.recordSubagentQuestion(
                  task.id,
                  request.subagentId,
                  request.requestId,
                  request.question,
                );
                this.events.emit("change", task.sessionId);

                return receipt;
              }

              case "request_start":
                return await this.store.startSubagentRequest(
                  task.id,
                  request.subagentId,
                  request.requestId,
                  request.kind,
                );
              case "request_finish":
                return await this.store.finishSubagentRequest(
                  task.id,
                  request.subagentId,
                  request.requestId,
                  request.result,
                );
              case "collect":
                return await this.store.collectSubagents(task.id, request.ids);
            }
          },
          acquireSubagentLease: async (candidate, id, requestSignal) => {
            await assertSubagentTask(candidate);
            if (
              !(await this.store.subagents(task.id)).some(
                (child) => child.id === id && child.status === "queued",
              )
            ) {
              throw new Error("子任务未登记或不在可申请租约的状态。");
            }

            const release = await this.subagentLimits.acquire(
              task.id,
              requestSignal,
            );
            try {
              await assertSubagentTask(candidate);
              requestSignal.throwIfAborted();
              if (
                !(await this.store.subagents(task.id)).some(
                  (child) => child.id === id && child.status === "queued",
                )
              ) {
                throw new Error("子任务等待租约期间状态已经变化。");
              }

              return release;
            } catch (error) {
              release();
              throw error;
            }
          },
          authorizeSubagentModel: async (candidate, id, requestId) => {
            await assertSubagentTask(candidate);
            const child = (await this.store.subagents(task.id)).find(
              (entry) => entry.id === id,
            );
            const request = await this.store.subagentRequest(
              task.id,
              id,
              requestId,
            );
            if (child?.status !== "running" || request?.status !== "started") {
              throw new Error("子模型请求没有对应运行中任务与已登记请求。");
            }
          },
          commitSubagentCollect: async (candidate, body) => {
            await assertSubagentTask(candidate);
            const last = body.input.at(-1) as
              { type?: string; call_id?: string; output?: string } | undefined;
            if (
              !last ||
              last.type !== "function_call_output" ||
              last.call_id !== body.event.callId ||
              last.output !== JSON.stringify(body.event.result)
            ) {
              throw new Error("子报告反馈未完整进入主模型上下文。");
            }

            const expected = await this.store.collectSubagents(
              task.id,
              body.ids,
            );
            const data = body.event.result as { reports?: unknown };
            if (JSON.stringify(data?.reports) !== JSON.stringify(expected)) {
              throw new Error("子报告回执与当前任务持久化状态不一致。");
            }

            const eventData = withRuntimeDuration(body.event);
            const clean = JSON.parse(
              redactJson(JSON.stringify(eventData), this.config.errorSecrets()),
            );
            const saved = await this.store.commitCollectedToolResult(
              task.id,
              body.ids,
              expected,
              clean,
              last,
              body.event.callId,
              clean.result,
            );
            this.events.emit("event", saved);
            this.events.emit("change", task.sessionId);
          },
          traceSpan: (event) => {
            if (!this.traces.acceptExternalTime(task.id, event.timestampUs)) {
              throw new Error("Agent Runtime trace 时间戳不属于当前任务。");
            }

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

              const subagentTrace = event.name.startsWith("subagent.");
              const readFileTrace = event.name.startsWith("read_file.");
              const processTrace = event.name.startsWith("process.");
              const executionTrace = event.name === "tool.execute";
              const readFileToolStage = readFileTrace;
              const callId = event.attributes.callId;
              const tool = callId ? runtimeToolCalls.get(callId) : undefined;
              if (
                (executionTrace || readFileToolStage || processTrace) &&
                !tool
              ) {
                throw new Error("Agent Runtime trace 工具调用未登记。");
              }

              if (executionTrace && callId) {
                runtimeToolTracks.set(
                  callId,
                  `Agent Runtime tool ${event.attributes.slot! + 1}`,
                );
              }

              if (
                readFileToolStage &&
                (!callId || !runtimeToolTracks.has(callId))
              ) {
                throw new Error("Agent Runtime read_file 阶段缺少执行槽。");
              }

              const subagentId = event.attributes.subagentId;
              if (
                subagentTrace &&
                (!subagentId || !runtimeSubagentIds.has(subagentId))
              ) {
                throw new Error("Agent Runtime subagent trace 身份未登记。");
              }

              runtimeContextSpans.set(
                event.spanId,
                this.traces.startSpan(task.id, {
                  name: executionTrace ? `tool.${tool!.name}` : event.name,
                  category: processTrace
                    ? "process"
                    : subagentTrace
                      ? "subagent"
                      : readFileTrace
                        ? "read_file"
                        : executionTrace
                          ? "tool"
                          : "context",
                  track: processTrace
                    ? "Runtime process lifecycle"
                    : subagentTrace
                      ? `Subagent ${subagentId}`
                      : readFileToolStage || executionTrace
                        ? runtimeToolTracks.get(callId!)!
                        : "Agent Runtime",
                  processId: launched?.pid,
                  startedAtUs: event.timestampUs,
                  parentSpanId: parent?.id,
                  attributes: executionTrace
                    ? {
                        ...event.attributes,
                        batchId: tool!.batchId,
                        nodeId: tool!.nodeId,
                        // Broker 宿主工具在 Runtime 的片段只表示等待，不冒充受限进程中的执行。
                        execution:
                          tool!.name === "run_with_permissions" ||
                          tool!.name === "mcp" ||
                          tool!.name === "skill"
                            ? "broker-host-wait"
                            : "runtime",
                        parameters:
                          // 宿主命令和审批理由只留会话记录，不进入 Runtime 等待片段。
                          tool!.name === "run_with_permissions" ||
                          tool!.name === "memory_apply" ||
                          tool!.name === "mcp" ||
                          tool!.name === "skill" ||
                          tool!.name === "subagent"
                            ? undefined
                            : JSON.parse(
                                redactJson(
                                  JSON.stringify(tool!.args),
                                  this.config.errorSecrets(),
                                ),
                              ),
                      }
                    : event.attributes,
                }),
              );
              const span = runtimeContextSpans.get(event.spanId);
              if (event.name === "tool.result_persist") {
                this.traces.relations.persistStarted(span);
              }

              if (executionTrace && callId && span) {
                runtimeToolExecutions.set(callId, span);
                this.traces.relations.toolStarted(span);
              }

              return;
            }

            const span = runtimeContextSpans.get(event.spanId);
            if (!span) {
              throw new Error(
                "Agent Runtime trace span 终态没有对应开始事件。",
              );
            }

            this.traces.endSpan(
              span,
              event.status,
              event.attributes,
              event.timestampUs,
            );
            if (span?.name.startsWith("tool.") && span.attributes.callId) {
              runtimeToolTracks.delete(String(span.attributes.callId));
            }

            runtimeContextSpans.delete(event.spanId);
          },
          executeSkill: (_runtime, request, toolCallId, requestSignal) =>
            skills.execute(request, requestSignal, toolCallId),
          prepareMcp: (_runtime, request, toolCallId, requestSignal) =>
            this.prepareMcp(
              task,
              workspace,
              request,
              toolCallId,
              requestSignal,
              settings.outputChars,
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
          appendContext: async (_runtime, items) => {
            await this.store.appendContextAsync(task.sessionId, items, task.id);
          },
          commitToolResult: async (candidate, body) => {
            if (
              !authorized ||
              candidate !== identity ||
              body.feedback.call_id !== body.event.callId
            ) {
              throw new Error("工具反馈不属于当前执行实例。");
            }

            await this.drainEvents(task.id);
            const data = JSON.parse(
              redactJson(
                JSON.stringify(withRuntimeDuration(body.event)),
                this.config.errorSecrets(),
              ),
            );
            const feedback = JSON.parse(
              redactJson(
                JSON.stringify(body.feedback),
                this.config.errorSecrets(),
              ),
            );
            const saved = await this.store.persistToolResultAsync(
              task.sessionId,
              task.id,
              data,
              feedback,
              body.event.callId,
              data.result,
            );
            this.traces.relations.event(task.id, "tool_result", data);
            this.events.emit("event", saved);
            this.events.emit("change", task.sessionId);
          },
          appendSessionEvent: async (_runtime, type, data) => {
            const eventData =
              type === "tool_result" ? withRuntimeDuration(data) : data;
            await captureToolEvent(type, eventData);
            emit(type, eventData);
            await this.drainEvents(task.id);
          },
          saveContext: async (_runtime, input) => {
            await this.store.saveContextAsync(task.sessionId, input, task.id);
          },
          saveTokenAnchor: async (_runtime, anchor) => {
            if (anchor.scope !== tokenScope(settings)) {
              throw new Error("Agent Runtime token 锚点不属于本任务模型配置。");
            }

            await this.store.saveTokenAnchorAsync(
              task.sessionId,
              anchor,
              task.id,
            );
          },
          readContext: () => this.store.contextAsync(task.sessionId),
          readEvents: () => this.store.relevantEventsAsync(task.sessionId),
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
      broker = currentBroker;
      const completionController = new AbortController();
      let cancellationDeadline: NodeJS.Timeout | undefined;
      let resolveCancellation!: () => void;
      const cancellationObserved = new Promise<void>((resolve) => {
        resolveCancellation = resolve;
      });
      const cancelled = () => {
        currentBroker.cancel("Broker 任务已取消。");
        resolveCancellation();
        // 请求取消先让 Runtime 回报可信终态；超时才放弃等待并走 unknown 清理。
        cancellationDeadline = setTimeout(
          () =>
            completionController.abort(
              new Error("Agent Runtime 取消后未在期限内返回终态。"),
            ),
          10_000,
        );
      };

      signal.addEventListener("abort", cancelled, { once: true });
      try {
        const memory = await this.memories.retrieve(workspace);
        signal.throwIfAborted();
        taskRequestStarted = true;
        const taskRequest = currentBroker.startTask(
          {
            workspace,
            prompt,
            settings: {
              model: settings.model,
              webSearchEnabled: protocolFeatures(settings.protocol).webSearch,
              maxSteps: settings.maxSteps,
              commandTimeoutMs: settings.commandTimeoutMs,
              maxOutputTokens: settings.maxOutputTokens,
              maxContextTokens: settings.maxContextTokens,
              contextChars: settings.contextChars,
              outputChars: settings.outputChars,
              subagentsEnabled: task.subagentsEnabled,
            },
            memoryText: memory.bundle?.text,
            skillsText: skills.instructions(),
            mcpText: mcpCatalogInstructions(
              this.taskConfig(task.id).mcpServers,
            ),
            tokenCalibration: {
              scope: tokenScope(settings),
              anchor: await this.store.tokenAnchorAsync(
                task.sessionId,
                task.id,
              ),
            },
          },
          completionController.signal,
        );
        const runtimeStopped = cancellationObserved
          .then(() => currentBroker.waitForStop(completionController.signal))
          .then(() => {
            runtimeStoppedObserved = true;
            if (!reported) {
              throw new Error("Agent Runtime 停止前未报告可信任务终态。");
            }

            return reported;
          });
        const response = (await Promise.race([
          taskRequest,
          runtimeStopped,
        ]).catch((error) => {
          runtimeError = error;
          throw error;
        })) as { status?: TaskStatus; failure?: string };
        const status = reported?.status ?? response.status;
        if (
          status !== "completed" &&
          status !== "failed" &&
          status !== "cancelled" &&
          status !== "interrupted"
        ) {
          throw new Error("Agent Runtime 未返回有效任务终态。");
        }

        if (
          signal.aborted &&
          status !== "completed" &&
          !runtimeStoppedObserved
        ) {
          throw new Error("Agent Runtime 取消后未确认停止状态。");
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
          throw new AgentRuntimeCleanupUnknownError();
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

        // Runtime 只知道 IPC cancel；是否由服务关闭引起须由 Broker 的原始信号判定。
        // 仅在已确认 Runtime 停止且清理成功后映射，unknown/orphaned 不会被关闭原因覆盖。
        const interrupted =
          status === "cancelled" &&
          signal.aborted &&
          signal.reason?.message?.startsWith("服务关闭");

        return {
          status: interrupted ? "interrupted" : status,
          failure: interrupted
            ? "服务关闭，任务中断，可手动恢复。"
            : (reported?.failure ?? response.failure),
        };
      } finally {
        signal.removeEventListener("abort", cancelled);
        if (cancellationDeadline) {
          clearTimeout(cancellationDeadline);
        }
      }
    } finally {
      authorized = false;
      for (const span of runtimeContextSpans.values()) {
        this.traces.endSpan(span, signal.aborted ? "cancelled" : "error", {
          incomplete: true,
        });
      }

      runtimeContextSpans.clear();
      runtimeToolExecutions.clear();
      let terminalUnknown = false;
      if (launched && !closeAttempted) {
        closeAttempted = true;
        const closeReason =
          taskRequestStarted &&
          (!reported || (signal.aborted && !runtimeStoppedObserved))
            ? "unknown"
            : signal.aborted
              ? "cancel"
              : "unknown";
        const cleanup = await launched
          .close(closeReason)
          .catch(() => "orphaned" as const);
        cleaned = cleanup === "clean";
        if (closeReason === "unknown" || cleanup !== "clean") {
          terminalUnknown = true;
          publishExecution("unknown", { sideEffectsPossible: true });
          publishSandboxStage("failed");
        } else {
          publishExecution("cancelled", { sideEffectsPossible: true });
          publishSandboxStage("failed");
        }
      }

      if (cleaned) {
        broker?.releaseSubagentLeases();
      }

      this.subagentLimits.cancelTask(task.id);
      if (terminalUnknown || (launched && !cleaned)) {
        throw new AgentRuntimeCleanupUnknownError(runtimeError);
      }
    }
  }

  /** Broker 先审查完整命令，再交给 Tool worker 槽中的一次性宿主执行闭包。 */
  private async prepareRuntimeCapabilityCommand(
    task: Task,
    workspace: string,
    request: CapabilityCommandRequest,
    toolCallId: string,
    signal: AbortSignal,
    settings: Settings,
    emit: (type: string, data: any) => void,
  ): Promise<(signal: AbortSignal) => Promise<CapabilityCommandResult>> {
    const shell = commandShell(process.env, undefined, process.platform, false);
    if (!shell) {
      throw new Error("Broker 宿主未找到可用的命令 shell。");
    }

    const allowed = await this.approvals.request(
      {
        sessionId: task.sessionId,
        taskId: task.id,
        tool: "run_with_permissions",
        description: JSON.stringify(
          {
            command: request.command,
            cwd: workspace,
            reason: request.reason,
            execution: "broker-host",
            authority:
              "使用 Broker 进程的宿主用户权限；文件、网络和凭据不再受 Sandbox 的额外限制。",
          },
          null,
          2,
        ),
      },
      signal,
    );
    if (!allowed) {
      throw new Error("Broker 宿主命令审批未通过。");
    }

    return async (executionSignal) => {
      executionSignal.throwIfAborted();
      emit("notice", {
        text: "本次 run_with_permissions 已获批准，命令将在 Broker 宿主用户权限下执行，不受 Sandbox 额外文件或网络限制。",
      });

      return this.executeReviewedBrokerCommand(
        task,
        workspace,
        shell,
        request.command,
        toolCallId,
        executionSignal,
        settings,
        emit,
      );
    };
  }

  /** 审批已完成；宿主命令单独归因，不能写成受 Sandbox 保护的 Runner。 */
  private async executeReviewedBrokerCommand(
    task: Task,
    workspace: string,
    shell: { command: string; args: string[] },
    command: string,
    toolCallId: string,
    signal: AbortSignal,
    settings: Settings,
    emit: (type: string, data: any) => void,
  ): Promise<CapabilityCommandResult> {
    const executionInstanceId = randomUUID();
    const createdAt = new Date().toISOString();
    let pid: number | undefined;
    const publish = (
      state: ExecutionInstanceState,
      // 通用命令无法从退出码证明无写入；一旦启动，成功也可能已有副作用。
      sideEffectsPossible = pid !== undefined,
    ) => {
      const record: ExecutionInstanceRecord = {
        executionInstanceId,
        toolCallId,
        kind: "broker-command",
        mode: "host-process",
        state,
        createdAt,
        updatedAt: new Date().toISOString(),
        sandboxRequested: false,
        sandboxApplied: false,
        pid,
        pidKind: pid === undefined ? undefined : "host-process",
        sideEffectsPossible,
      };
      emit("execution_instance", record);
      this.sandbox.recordExecutionInstance(record);
    };

    publish("created");
    const span = this.traces.startSpan(task.id, {
      name: "broker.command",
      category: "tool",
      track: "Broker host commands",
      attributes: { executionInstanceId, toolCallId, mode: "host-process" },
    });

    try {
      const result = await executeProcess(
        shell.command,
        [...shell.args, command],
        workspace,
        signal,
        0,
        settings.outputChars,
        (text) => emit("capability_output", { text, callId: toolCallId }),
        {},
        (startedPid) => {
          pid = startedPid;
          publish("running");
        },
        undefined,
        undefined,
        this.processReviewer(task, settings, {
          name: "run_with_permissions",
          arguments: { command },
          callId: toolCallId,
        }),
      );
      publish(result.exitCode === 0 ? "completed" : "failed");
      this.traces.endSpan(span, result.exitCode === 0 ? "ok" : "error");

      return { executionInstanceId, ...result };
    } catch (error) {
      publish(
        signal.aborted ? "cancelled" : pid === undefined ? "failed" : "unknown",
        pid !== undefined,
      );
      this.traces.endSpan(span, signal.aborted ? "cancelled" : "error");
      throw error;
    }
  }

  private async run(
    task: Task,
    prompt: string,
    signal: AbortSignal,
    generateTitle: boolean,
  ) {
    const session = (await this.store.get(task.sessionId))!;
    const settings = this.taskConfig(task.id).settings;
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
      JSON.parse(
        redactJson(JSON.stringify(value), this.config.errorSecrets()),
      ) as T;
    const flush = () => {
      if (buffer) {
        emit("delta", { text: buffer, step, attempt });
        buffer = "";
        lastFlush = Date.now();
      }
    };

    try {
      const workspaceSpan = this.traces.startSpan(task.id, {
        name: "worktree.validate",
        category: "worktree",
        track: "Task preparation",
      });
      try {
        await this.worktrees.validate(session.workspace);
        this.traces.endSpan(workspaceSpan, "ok");
      } catch (error) {
        this.traces.endSpan(workspaceSpan, "error");
        throw error;
      }

      await this.store.replayAsync(task.id, "create", null, {
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

      const skills = await TaskSkills.create(
        {
          workspace: session.workspace,
          taskId: task.id,
          sessionId: session.id,
          log,
          traces: this.traces,
        },
        signal,
      );

      if (this.agentRuntimeLauncher && this.config.sandbox.enabled) {
        const runtimeToolCalls = new Map<
          string,
          { name: string; args: unknown; batchId: string; nodeId: string }
        >();
        let runtimeProcessId: number | undefined;
        let runtimeCompactionSpan: TraceSpan | undefined;
        const captureRuntimeToolEvent = async (type: string, data: any) => {
          this.traces.relations.event(task.id, type, data, true);
          if (type === "tool_start") {
            await this.store.replayAsync(
              task.id,
              "toolStart",
              null,
              cleanReplay({
                name: data.name,
                callId: data.callId,
                batchId: data.batchId,
                nodeId: data.nodeId,
                dependsOn: data.dependsOn,
                arguments: data.args,
              }),
            );
            runtimeToolCalls.set(data.callId, {
              name: String(data.name).slice(0, 80),
              args: data.args,
              batchId: data.batchId,
              nodeId: data.nodeId,
            });
          } else if (type === "tool_result") {
            await this.store.replayAsync(
              task.id,
              "toolFinish",
              data.callId,
              cleanReplay(data.result),
            );
            runtimeToolCalls.delete(data.callId);
          } else if (type === "tool_batch_planned") {
            this.traces.instant(
              task.id,
              "tool.plan",
              "tool",
              "Agent Runtime",
              {
                batchId: data.batchId,
                nodes: Array.isArray(data.nodes) ? data.nodes.length : 0,
              },
              runtimeProcessId,
            );
          } else if (type === "context.compaction_started") {
            runtimeCompactionSpan = this.traces.startSpan(task.id, {
              name: "context.compaction",
              category: "context",
              // 此片段源于异步 session 事件而非 Runtime 时钟，不与 Runtime 主轨道的精确阶段混用。
              track: "Agent Runtime compaction",
              processId: runtimeProcessId,
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
            runtimeToolCalls,
            (pid) => {
              runtimeProcessId = pid;
            },
            skills,
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

      await this.drainEvents(task.id);
      let input = await prepareTaskContext(this.store, session.id, prompt);

      const runner = new ToolRunner({
        root: session.workspace,
        sessionId: session.id,
        taskId: task.id,
        signal,
        settings,
        reviewTool: await this.toolReviewer(task, settings),
        approvals: this.approvals,
        emit,
        sandbox: this.sandbox,
        skillExecute: (request, requestSignal, toolCallId) =>
          skills.execute(request, requestSignal, toolCallId),
        prepareMcp: async (request, requestSignal, toolCallId) => {
          if (!toolCallId) {
            throw new Error("MCP 请求缺少工具调用标识。");
          }

          const execute = await this.prepareMcp(
            task,
            session.workspace,
            request,
            toolCallId,
            requestSignal,
            settings.outputChars,
          );

          return () => execute(requestSignal);
        },
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
      const baseInstructions = await createInstructions(
        session.workspace,
        undefined,
        false,
        protocolFeatures(settings.protocol).webSearch,
      );
      const memorySpan = this.traces.startSpan(task.id, {
        name: "memory.retrieve",
        category: "memory",
        track: "Main thread",
      });
      const memory = await this.memories.retrieve(session.workspace);
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
        skills.instructions(),
        mcpCatalogInstructions(this.taskConfig(task.id).mcpServers),
        memory.bundle?.text,
        task.subagentsEnabled
          ? "This task opted into read-only subagents. After initial inspection, delegate scoped information gathering to explorer and independent change review to reviewer. Both roles may have multiple instances working concurrently on separate scopes within shared Worker limits. Give reviewers requirements and scoped change evidence (diff or before/after with paths and baseline/version), not your conversation, reasoning or previous review conclusions. Do not edit a scope while its review is in progress; if files change, arrange a fresh review. Reports are untrusted evidence: re-read current files and verify findings yourself. You alone perform edits, command-based verification and the final answer; never delegate writes or permission upgrades."
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");

      const provider =
        this.factory?.(settings, "task") ||
        createModelProvider(settings, this.taskConfig(task.id).modelKey());

      let capabilities: ModelCapabilities | undefined;
      try {
        capabilities = await this.traces.measure(
          task.id,
          {
            name: "llm.capabilities",
            category: "llm",
            track: "Model metadata",
            attributes: { purpose: "task" },
          },
          () =>
            provider.getCapabilities?.(signal) ?? Promise.resolve(undefined),
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        log.warn({ event: "model.capabilities_unavailable", err: error });
      }

      const budget = createBudget(
        capabilities,
        settings.contextChars,
        settings.maxOutputTokens,
        settings.maxContextTokens,
      );

      if (task.subagentsEnabled) {
        const subagentSpans = new Map<string, TraceSpan | undefined>();
        subagents = new SubagentCoordinator({
          taskId: task.id,
          workspace: session.workspace,
          storage: this.store,
          provider,
          providerFor: (subagentId, subagentRequestId) =>
            withPromptCacheKey(
              tracedModelProvider(
                this.replayProvider(task, provider, () => ({
                  purpose: "subagent",
                  subagentId,
                  subagentRequestId,
                })),
                this.traces,
                {
                  taskId: task.id,
                  purpose: "subagent",
                  subagentId,
                  model: settings.model,
                },
              ),
              session.id,
              { taskId: task.id, subagentId },
            ),
          webSearchEnabled: protocolFeatures(settings.protocol).webSearch,
          // 字符备用模式也遵循用户输出设置；不恢复旧的子任务固定输出配额。
          maxOutputTokens:
            budget.outputTokens ??
            Math.min(
              settings.maxOutputTokens ?? 16_384,
              capabilities?.limits.max_output_tokens ?? Infinity,
            ),
          limits: this.subagentLimits,
          signal,
          onStateChange: () => this.events.emit("change", session.id),
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

      emit("context_budget", {
        model: settings.model,
        unit: budget.unit,
        inputLimit: budget.limit,
        contextWindowTokens: capabilities?.limits.max_context_window_tokens,
        effectiveWindowTokens: budget.contextWindowTokens,
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
        if (purpose === "task") {
          context.observeUsage(usage);
        }

        this.recordModelUsage(task, usage, purpose, {
          step,
          attempt: purpose === "task" ? attempt : undefined,
        });
      };

      // web_search 由 Responses 服务在单次模型请求内完成；仅本地 function_call 才进入后续 DAG。
      const tools = [
        ...definitions,
        ...(protocolFeatures(settings.protocol).webSearch
          ? [webSearchTool]
          : []),
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

      const calibration = new SessionTokenCalibration({
        budget,
        scope: tokenScope(settings),
        read: () => this.store.tokenAnchorAsync(session.id, task.id),
        write: (anchor) =>
          this.store.saveTokenAnchorAsync(session.id, anchor, task.id),
        trace: contextTrace,
        signal,
      });
      await calibration.restore(input, instructions, tools);
      const context = new ContextManager({
        store: this.store,
        sessionId: session.id,
        model: settings.model,
        limit: budget.limit,
        currentFileHash: (file) => runner.currentFileHash(file),
        measure: budget.measure,
        resetMeasurement: budget.resetMeasurement,
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
        summaryBudget: async () =>
          createBudget(
            capabilities,
            settings.contextChars,
            settings.maxOutputTokens,
          ),
        summaryModel: settings.auxiliaryModel
          ? async () => {
              const selected = auxiliarySettings(settings);
              const auxiliary =
                this.factory?.(selected, "auxiliary") ??
                createModelProvider(
                  selected,
                  this.taskConfig(task.id).modelKey(true),
                );
              let metadata: ModelCapabilities | undefined;
              try {
                metadata = await this.traces.measure(
                  task.id,
                  {
                    name: "llm.capabilities",
                    category: "llm",
                    track: "Model metadata",
                    attributes: { purpose: "compaction" },
                  },
                  () =>
                    auxiliary.getCapabilities?.(signal) ??
                    Promise.resolve(undefined),
                  signal,
                );
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
        clean: (text) => redactJson(text, this.config.errorSecrets()),
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
        maxSteps:
          this.modelStepLimitOverride === undefined
            ? settings.maxSteps
            : this.modelStepLimitOverride,
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
          await this.drainEvents(task.id);

          return withPromptCacheKey(
            tracedModelProvider(
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
            ),
            session.id,
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
              ? redactText(error.requestId, this.config.errorSecrets())
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
        acceptResponse: async (response, calls) => {
          const responseSpan = this.traces.startSpan(task.id, {
            name: "model.response_process",
            category: "agent",
            track: "Main thread",
            attributes: { attempt, step },
          });
          try {
            flush();
            signal.throwIfAborted();
            await acceptModelResponse(response, {
              input,
              requestInput,
              instructions,
              tools,
              calibration,
              recordUsage: (usage) => recordUsage(usage, "task"),
              appendContext: (output) =>
                this.store.appendContextAsync(session.id, output, task.id),
              emitAssistant: (text) =>
                emit("assistant", { text, step, attempt }),
            });

            await this.drainEvents(task.id);
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
          const saveResult = async (
            node: ToolGraphNode,
            result: any,
            executionStartedAt?: number,
          ) => {
            const serialized = serializeToolOutput(
              result,
              settings.outputChars,
            );
            const completeOutput = serialized.complete;
            const output = redactJson(
              serialized.output,
              this.config.errorSecrets(),
            );
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
            this.traces.relations.persistStarted(persistenceSpan);
            // 工具副作用无法由 SQLite 回滚；每个并行节点完成后立即原子保存结果和模型反馈。
            try {
              const eventData = {
                name: node.name,
                callId: node.callId,
                batchId,
                nodeId: node.nodeId,
                dependsOn: node.dependsOn,
                result: JSON.parse(output),
                durationMs,
              };
              const feedback = {
                type: "function_call_output",
                call_id: node.callId,
                output,
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
                await this.drainEvents(task.id);
                const event = await this.store.commitCollectedToolResult(
                  task.id,
                  subagentRequest.subagentIds,
                  result.reports,
                  eventData,
                  feedback,
                  node.callId,
                  cleanReplay(result),
                );
                input.push(feedback);
                this.events.emit("event", event);
                this.events.emit("change", session.id);
              } else {
                await this.drainEvents(task.id);
                const event = await this.store.persistToolResultAsync(
                  session.id,
                  task.id,
                  eventData,
                  feedback,
                  node.callId,
                  cleanReplay(result),
                );
                input.push(feedback);
                this.events.emit("event", event);
                this.events.emit("change", session.id);
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
              subagentsEnabled: task.subagentsEnabled,
            });
          } catch (error: any) {
            this.traces.endSpan(planningSpan, "error", {
              errorName: error instanceof Error ? error.name : typeof error,
            });
            const message = redactText(
              error.message,
              this.config.errorSecrets(),
            );
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
              await this.store.replayAsync(
                task.id,
                "toolStart",
                null,
                cleanReplay({
                  name: node.name,
                  callId: node.callId,
                  batchId,
                  nodeId: node.nodeId,
                  dependsOn: node.dependsOn,
                  arguments: node.arguments,
                }),
              );
              await saveResult(node, { error: `工具调用图无效：${message}` });
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
            await this.store.replayAsync(
              task.id,
              "toolStart",
              null,
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
              redactJson(
                JSON.stringify(arguments_),
                this.config.errorSecrets(),
              ),
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
              execute: async (node, acquireExecutionSlot) =>
                this.traces.measure(
                  task.id,
                  {
                    name: "tool.node",
                    category: "scheduler",
                    track: "Tool scheduler",
                    attributes: {
                      callId: node.callId,
                      batchId,
                      nodeId: node.nodeId,
                    },
                  },
                  async () => {
                    signal.throwIfAborted();
                    let slot: number | undefined;
                    let executionStartedAt: number | undefined;
                    let toolSpan: ReturnType<TraceRecorder["startSpan"]>;
                    let result: any;
                    const readFileSpans = new Map<
                      ReadFileTraceStage,
                      ReturnType<TraceRecorder["startSpan"]>
                    >();
                    const traceReadFile: ReadFileTrace = (
                      stage,
                      state,
                      details,
                    ) => {
                      if (state === "started") {
                        readFileSpans.set(
                          stage,
                          this.traces.startSpan(task.id, {
                            name: stage,
                            category: "read_file",
                            // 路径准备已结束；所有剩余阶段都在取得执行槽后上报。
                            track: `Tool worker ${slot! + 1}`,
                            parentSpanId: toolSpan?.id,
                            attributes: {
                              batchId,
                              callId: node.callId,
                              nodeId: node.nodeId,
                            },
                          }),
                        );
                      } else {
                        this.traces.endSpan(
                          readFileSpans.get(stage),
                          state,
                          details,
                        );
                        readFileSpans.delete(stage);
                      }
                    };

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
                        category:
                          node.name === "memory_apply" ? "memory" : "tool",
                        track: `Tool worker ${slot + 1}`,
                        attributes: {
                          batchId,
                          callId: node.callId,
                          nodeId: node.nodeId,
                          parameters:
                            node.name === "run_with_permissions" ||
                            node.name === "memory_apply" ||
                            node.name === "subagent" ||
                            node.name === "mcp" ||
                            node.name === "skill"
                              ? undefined
                              : traceToolParameters(node.arguments),
                        },
                      });
                      this.traces.relations.toolStarted(toolSpan);
                    };

                    try {
                      result = await dispatchModelTool(node, {
                        subagentsEnabled: task.subagentsEnabled,
                        subagents,
                        runner,
                        startExecution,
                        afterSubagentWait: startExecution,
                        readHistory: (arguments_) =>
                          readContextHistoryAsync(
                            this.store,
                            session.id,
                            arguments_,
                            settings.outputChars,
                          ),
                        traceReadFile,
                      });
                    } catch (error: any) {
                      if (signal.aborted) {
                        throw error;
                      }

                      result = {
                        error: redactText(
                          error.message,
                          this.config.errorSecrets(),
                        ),
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
                            Array.isArray(file.matchModes)
                              ? file.matchModes
                              : [],
                          )
                        : [];
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
                    await saveResult(node, result, executionStartedAt);

                    return toolSucceeded(result);
                  },
                  signal,
                ),
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
                await saveResult(node, {
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
      status =
        error instanceof AgentRuntimeCleanupUnknownError
          ? "failed"
          : signal.aborted
            ? signal.reason?.message?.startsWith("服务关闭")
              ? "interrupted"
              : "cancelled"
            : "failed";
      failure =
        error instanceof AgentRuntimeCleanupUnknownError
          ? error.message
          : signal.aborted
            ? status === "interrupted"
              ? "服务关闭，任务中断，可手动恢复。"
              : "任务已取消，可手动恢复。"
            : redactText(
                String(error?.message || "任务失败").slice(0, 2000),
                this.config.errorSecrets(),
              );
      emit("notice", { text: failure, status });
      log[status === "failed" ? "error" : "info"]({
        event: "task." + status,
        code: error?.code,
        message: failure,
        ...(status === "failed" ? { err: error } : {}),
      });
    } finally {
      try {
        await this.mcpTasks.get(task.id)?.close();
      } catch (error) {
        status = "failed";
        failure = "MCP 连接清理失败，任务结果不能视为完成。";
        log.error({ event: "mcp.cleanup_failed", err: error });
      } finally {
        this.mcpTasks.delete(task.id);
      }

      try {
        await subagents?.close();
      } catch (error) {
        status = "failed";
        failure = "subagent 退出或状态落盘失败，任务结果不能视为完成。";
        log.error({ event: "subagent.cleanup_failed", err: error });
      }

      try {
        await this.drainEvents(task.id);
      } catch (error) {
        status = "failed";
        failure = "事件持久化失败，请检查存储状态后恢复。";
        log.error({ event: "task.persistence_failed", err: error });
      }

      try {
        try {
          await this.store.statusAsync(task.id, status, failure);
        } catch (error) {
          // 保留原始写入失败给 launch 的恢复入口；不能让 trace 仍把已执行但未落盘的任务标成成功。
          status = "failed";
          throw error;
        }

        try {
          await this.store.replayAsync(task.id, "finish", null, status);
          this.traces.endSpan(replayCaptureSpan, "ok");
        } catch (error) {
          this.traces.endSpan(replayCaptureSpan, "error", {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          log.error({ event: "replay.capture_failed", err: error });
        }
      } finally {
        // 诊断失败不能覆盖产品失败或把完成任务改成 failed；即使导出抛错也必须释放运行期记录。
        try {
          await this.traceTasks.finish(
            task.id,
            task.sessionId,
            status === "completed"
              ? "ok"
              : status === "cancelled" || status === "interrupted"
                ? "cancelled"
                : "error",
          );
        } catch (error) {
          log.warn({ event: "tracing.finalize_failed", err: error });
        } finally {
          this.traces.discardTask(task.id);
          this.sandbox.releaseTask(task.id);
        }
      }

      emit("task_end", { status });
      await this.drainEvents(task.id);
      this.workerTasks.delete(task.id);
      log.info({ event: "task.finished", status });
    }
  }
}
