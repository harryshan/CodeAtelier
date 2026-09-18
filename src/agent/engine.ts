/**
 * CodeAtelier 的任务执行入口，把模型请求、工具调用 DAG、审批和历史保存串起来。
 * HTTP 服务和手动评测都会创建 Engine；任务记录写入 Store，界面通过事件获知变化。
 *
 * 1. 构造器接好审批通知；snapshot 读取会话状态，emit 脱敏并保存事件。
 * 2. start 保存用户消息为 queued；调度器在全局并发上限内启动不同工作区的任务，并对相同真实工作区保持互斥。
 * 3. resume 继续最后一个可恢复任务；cancel 处理用户取消，close 处理服务关闭。
 * 4. 首条 prompt 先用辅助模型生成标题；run 再读取历史和项目规则，准备工具及上下文预算。
 * 5. 为压缩提供 ToolRunner 的安全文件哈希探测；每轮记录上下文准备和请求视图的内部安全阶段、模型重试、实际模型请求和响应处理，再记录服务实报用量。完整响应保存后校验工具 DAG，再按拓扑关系调度。
 * 6. 每个实际工具调用仍经过低成本模型的自动通过、人工确认或拒绝分流；模型故障和无效输出保守降级为人工确认，并持久化可审计的决定。
 * 7. 工具批次、节点状态和结果都附带批次/调用标识；ToolRunner 确认实际执行开始后才记录工具耗时，并在可复用调度轨道显示执行和结果持久化；退出时将安全 trace 写入会话/任务文件、释放运行期记录并发出 task_end。
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
  parseScheduledHistoryArguments,
  readContextHistoryAsync,
} from "../context/history.js";
import { prepareTaskContext } from "./context.js";
import { createInstructions } from "./instructions.js";
import { retryModel } from "../providers/retry.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { definitions, parseScheduledToolArguments } from "../tools/registry.js";
import {
  createToolGraph,
  DEFAULT_TOOL_CONCURRENCY,
  executeToolGraph,
  type ToolGraphNode,
} from "../tools/tool-graph.js";
import { redactJson, redactText } from "../logging/redact.js";
import { tracedModelProvider } from "../tracing/model-provider.js";
import { TraceArchive } from "../tracing/archive.js";
import { TraceRecorder } from "../tracing/recorder.js";
import type { TraceSpan } from "../tracing/types.js";
import type { Task, TaskStatus } from "../shared/types.js";

// 标题请求没有工具或文件副作用；服务未提供可分类原因时，允许比主任务多一次诊断性重试。
const titleRetryOptions = { retries: 3, retryUnknownErrors: true };

type ModelUsagePurpose = "task" | "compaction" | "title" | "approval";

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
  /** 当前进程仅保留运行中任务构造 trace 所需的状态，任务落盘后立即释放。 */
  readonly traces = new TraceRecorder();
  /** 已结束任务的 trace 另行按会话/任务写入数据目录，服务重启后仍可下载。 */
  readonly traceArchive: TraceArchive;

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
  ) {
    this.traceArchive = new TraceArchive(config.directory, log);
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
    details: { step?: number; attempt?: number } = {},
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

  start(
    sessionId: string,
    prompt: string,
    recovery?: { sourceTaskId: string; originalPrompt: string },
  ) {
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

      const created = this.store.createTask(sessionId);
      const firstPrompt =
        session.titleState === "pending" &&
        !this.store.hasEvent(sessionId, "user");

      this.emit(created, "user", { text: prompt });
      if (recovery) {
        this.emit(created, "recovery", recovery);
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
      { sourceTaskId: id, originalPrompt: prompt },
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

      let input = await prepareTaskContext(this.store, session.id, prompt);

      const runner = new ToolRunner({
        root: session.workspace,
        sessionId: session.id,
        taskId: task.id,
        signal,
        settings,
        approvals: this.approvals,
        emit,
      });
      const instructions = await createInstructions(session.workspace);

      const provider =
        this.factory?.(settings, "task") ||
        new ResponsesProvider(settings, this.config.apiKey);

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

      const tools = [...definitions, historyDefinition];
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

      let overflowRetried = false;

      for (step = 1; step <= settings.maxSteps; step++) {
        signal.throwIfAborted();
        input = await prepareContext();

        lastFlush = Date.now();
        log.debug({ event: "model.started", step });
        // 这里只重试模型请求。完整响应保存成功后，才能执行其中的工具调用。
        let attemptOffset = 0;
        let requestInput = input;
        let retryDelaySpan: ReturnType<TraceRecorder["startSpan"]>;
        const requestModel = () =>
          retryModel(
            async (currentAttempt) => {
              attempt = attemptOffset + currentAttempt;
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
                    errorName:
                      error instanceof Error ? error.name : typeof error,
                  },
                );
                throw error;
              } finally {
                if (contextTraceParent === requestSpan) {
                  contextTraceParent = undefined;
                }
              }

              if (request.after < request.before) {
                log.debug({
                  event: "context.mechanical",
                  step,
                  attempt,
                  before: request.before,
                  after: request.after,
                  unit: budget.unit,
                });
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
            signal,
            (error, failedAttempt, delayMs) => {
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
          );
        const response = await requestModel().catch(async (error) => {
          if (error?.code !== "context_length_exceeded" || overflowRetried) {
            throw error;
          }

          // 失败前收到的文本留在原 attempt 中，不能和下一次请求的回复拼在一起。
          flush();
          attemptOffset = attempt;
          lastFlush = Date.now();
          overflowRetried = true;
          input = await prepareContext(true);

          return requestModel();
        });

        const responseSpan = this.traces.startSpan(task.id, {
          name: "model.response_process",
          category: "agent",
          track: "Main thread",
          attributes: { attempt, step },
        });
        let calls;
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

          calls = response.output.filter((i) => i.type === "function_call");
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
        if (!calls.length) {
          if (!response.text) {
            throw new Error("模型未返回文本或工具调用。");
          }

          return;
        }

        const batchId = randomUUID();
        const modelSpan = this.traces.latestSpan(task.id, "llm");
        const toolSucceeded = (result: any) =>
          !result?.error &&
          (result?.exitCode === undefined || result.exitCode === 0) &&
          !result?.files?.some(
            (file: any) =>
              file.status === "failed" || file.status === "unknown",
          );
        const saveResult = (
          node: ToolGraphNode,
          result: any,
          executionStartedAt?: number,
        ) => {
          let output = JSON.stringify(result);

          if (output.length > settings.outputChars) {
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
            this.store.transaction(() => {
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
            });
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
          graph = createToolGraph(
            calls.map((call, ordinal) => {
              const raw = JSON.parse(call.arguments);
              const scheduled =
                call.name === historyDefinition.name
                  ? parseScheduledHistoryArguments(raw, `call-${ordinal + 1}`)
                  : parseScheduledToolArguments(
                      call.name,
                      raw,
                      `call-${ordinal + 1}`,
                    );

              return {
                callId: call.call_id,
                nodeId: scheduled.execution.id,
                name: call.name,
                arguments: scheduled.arguments,
                dependsOn: scheduled.execution.dependsOn,
                ordinal,
              };
            }),
          );
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

          continue;
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
            execute: async (node, slot) => {
              signal.throwIfAborted();
              let executionStartedAt: number | undefined;
              let toolSpan: ReturnType<TraceRecorder["startSpan"]>;
              let result: any;

              try {
                if (node.name === historyDefinition.name) {
                  executionStartedAt = Date.now();
                  toolSpan = this.traces.startSpan(task.id, {
                    name: "tool.read_context_history",
                    category: "tool",
                    track: `Tool worker ${slot + 1}`,
                    attributes: {
                      batchId,
                      callId: node.callId,
                      nodeId: node.nodeId,
                      parameters: traceToolParameters(node.arguments),
                    },
                  });
                  result = await readContextHistoryAsync(
                    this.store,
                    session.id,
                    node.arguments,
                    settings.outputChars,
                  );
                } else {
                  result = await runner
                    .forCall(node.callId)
                    .execute(node.name, node.arguments, () => {
                      executionStartedAt = Date.now();
                      toolSpan = this.traces.startSpan(task.id, {
                        name: `tool.${node.name}`,
                        category: "tool",
                        track: `Tool worker ${slot + 1}`,
                        attributes: {
                          batchId,
                          callId: node.callId,
                          nodeId: node.nodeId,
                          parameters: traceToolParameters(node.arguments),
                        },
                      });
                    });
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
                      ? editMatchModes.filter((mode) => mode === "exact").length
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
      }

      throw new Error("已达到最大模型调用次数，任务停止。");
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

      emit("task_end", { status });
      log.info({ event: "task.finished", status });
    }
  }
}
