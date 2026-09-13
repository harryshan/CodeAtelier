/**
 * CodeAtelier 的任务执行入口，把模型请求、工具执行、审批和历史保存串起来。
 * HTTP 服务和手动评测都会创建 Engine；任务记录写入 Store，界面通过事件获知变化。
 *
 * 1. 构造器接好审批通知；snapshot 读取会话状态，emit 脱敏并保存事件。
 * 2. start 确保同一时间只有一个任务，保存用户消息，并准备取消信号和完成通知。
 * 3. resume 继续最后一个可恢复任务；cancel 处理用户取消，close 处理服务关闭。
 * 4. 首条 prompt 先用辅助模型生成标题；run 再读取历史和项目规则，准备工具及上下文预算。
 * 5. 每轮先整理上下文，再请求模型。只有完整响应保存成功后，才按顺序执行工具。
 * 6. 多文件编辑进度附带 callId 逐项保存；工具结果和更新后的上下文一起提交到数据库；退出时保存最终状态并发出 task_end。
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
import { ContextManager } from "../context/context-manager.js";
import { historyDefinition, readContextHistory } from "../context/history.js";
import { prepareTaskContext } from "./context.js";
import { createInstructions } from "./instructions.js";
import { retryModel } from "../providers/retry.js";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { Store } from "../sessions/store.js";
import { generateConversationTitle } from "../sessions/title-generator.js";
import { Config } from "../config/config.js";
import { ApprovalManager } from "../permissions/approval-manager.js";
import { ResponsesProvider } from "../providers/responses-provider.js";
import { type ModelProvider } from "../providers/model-provider.js";
import { ToolRunner } from "../tools/tool-runner.js";
import { definitions } from "../tools/registry.js";
import { redactJson, redactText } from "../logging/redact.js";
import type { Task, TaskStatus } from "../shared/types.js";

export class Engine {
  events = new EventEmitter();
  approvals: ApprovalManager;
  active?: { task: Task; controller: AbortController; done: Promise<void> };

  constructor(
    public store: Store,
    public config: Config,
    private log: Logger,
    private factory?: (
      settings: Settings,
      purpose: "task" | "auxiliary",
    ) => ModelProvider,
  ) {
    this.approvals = new ApprovalManager(() => {
      if (this.active) {
        const waiting =
          this.approvals.list(this.active.task.sessionId).length > 0;

        this.store.status(this.active.task.id, waiting ? "waiting" : "running");
        this.events.emit("change", this.active.task.sessionId);
      }
    });
  }

  snapshot(id: string) {
    return {
      session: this.store.get(id),
      events: this.store.events(id),
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

  start(
    sessionId: string,
    prompt: string,
    recovery?: { sourceTaskId: string; originalPrompt: string },
  ) {
    if (this.active) {
      throw new Error("已有任务运行，请等待或取消。");
    }

    const session = this.store.get(sessionId);

    if (!session) {
      throw new Error("会话不存在");
    }

    // 任务和用户消息一起保存，避免恢复时找不到用户原本要求做什么。
    // 标题领取和首条消息同一事务提交，恢复或后续追问不能拿来覆盖原标题。
    const { task, generateTitle } = this.store.transaction(() => {
      const created = this.store.createTask(sessionId);
      const firstPrompt =
        session.titleState === "pending" &&
        !this.store.events(sessionId).some((event) => event.type === "user");

      this.emit(created, "user", { text: prompt });
      if (recovery) {
        this.emit(created, "recovery", recovery);
      }

      return {
        task: created,
        generateTitle:
          firstPrompt && this.store.startTitleGeneration(sessionId),
      };
    });
    const controller = new AbortController();

    this.active = { task, controller, done: Promise.resolve() };
    this.active.done = this.run(task, prompt, controller.signal, generateTitle)
      .catch((error) => {
        this.log.error({
          event: "task.persistence_failed",
          taskId: task.id,
          errorName: error?.name,
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
        this.active = undefined;
        this.events.emit("change", sessionId);
      });

    return task;
  }

  resume(id: string, instruction = "") {
    if (this.active) {
      throw new Error("已有任务运行，请等待或取消。");
    }

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

    const events = this.store.events(task.sessionId);
    const prompt =
      events.find((e) => e.taskId === id && e.type === "recovery")?.data
        .originalPrompt ||
      events.find((e) => e.taskId === id && e.type === "user")?.data.text;

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
    if (this.active?.task.id === id) {
      this.active.controller.abort();
    }
  }

  async close() {
    this.active?.controller.abort(
      new Error("服务关闭，任务中断，可手动恢复。"),
    );
    await this.active?.done;
  }

  /** 生成标题失败时保留占位值；只有取消需要中止主任务，避免辅助能力降低可用性。 */
  private async generateTitle(
    sessionId: string,
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
        () => generateConversationTitle(provider, prompt, signal),
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
      );

      this.store.completeTitleGeneration(sessionId, title);
      this.events.emit("change", sessionId);
      log.info({
        event: "session.title_generated",
        model: selected.model,
        titleLength: title.length,
      });
    } catch (error: any) {
      if (signal.aborted) {
        // 取消后的请求不会返回结果；结束标题状态，防止恢复任务永久卡在 generating。
        this.store.failTitleGeneration(sessionId);
        this.events.emit("change", sessionId);
        throw signal.reason;
      }

      this.store.failTitleGeneration(sessionId);
      this.events.emit("change", sessionId);
      log.warn({
        event: "session.title_generation_failed",
        model: selected.model,
        errorName: error?.name,
        code: error?.code,
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
    let status: TaskStatus = "completed";
    let failure: string | undefined;
    const emit = (type: string, data: any) => this.emit(task, type, data);
    let step = 0;
    let attempt = 1;
    let buffer = "";
    let lastFlush = 0;
    const flush = () => {
      if (buffer) {
        emit("delta", { text: buffer, step, attempt });
        buffer = "";
        lastFlush = Date.now();
      }
    };

    try {
      if (generateTitle) {
        await this.generateTitle(session.id, prompt, settings, signal, log);
      }

      let input = prepareTaskContext(this.store, session.id, prompt);

      let currentToolCallId: string | undefined;
      const runner = new ToolRunner({
        root: session.workspace,
        sessionId: session.id,
        taskId: task.id,
        signal,
        settings,
        approvals: this.approvals,
        emit: (type, data) =>
          emit(
            type,
            type === "edit_progress"
              ? { ...data, callId: currentToolCallId }
              : data,
          ),
      });
      const instructions = await createInstructions(session.workspace);

      const provider =
        this.factory?.(settings, "task") ||
        new ResponsesProvider(settings, this.config.apiKey);

      let capabilities: ModelCapabilities | undefined;
      try {
        capabilities = await provider.getCapabilities?.(signal);
      } catch {
        signal.throwIfAborted();
        log.warn({ event: "model.capabilities_unavailable" });
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
        emit("model_usage", {
          ...usage,
          purpose,
          step,
          attempt: purpose === "task" ? attempt : undefined,
        });
        log.info({ event: "model.usage", purpose, step, ...usage });
      };

      const tools = [...definitions, historyDefinition];
      const context = new ContextManager({
        store: this.store,
        sessionId: session.id,
        model: settings.model,
        limit: budget.limit,
        measure: budget.measure,
        unit: budget.unit,
        maxOutputTokens: budget.outputTokens,
        onUsage: (usage) => recordUsage(usage, "compaction"),
        provider,
        summaryModel: settings.auxiliaryModel
          ? async () => {
              const selected = auxiliarySettings(settings);
              const auxiliary =
                this.factory?.(selected, "auxiliary") ??
                new ResponsesProvider(selected, this.config.apiKey);
              let metadata: ModelCapabilities | undefined;
              try {
                metadata = await auxiliary.getCapabilities?.(signal);
              } catch {
                signal.throwIfAborted();
                log.warn({
                  event: "model.capabilities_unavailable",
                  purpose: "compaction",
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
                provider: auxiliary,
                model: selected.model,
                budget: summaryBudget,
              };
            }
          : undefined,
        signal,
        clean: (text) => redactJson(text, [this.config.apiKey]),
        notice: (text) => emit("notice", { text }),
        report: (event, data) => {
          log[event.endsWith("failed") ? "warn" : "info"]({
            event,
            unit: budget.unit,
            ...data,
          });
        },
      });
      let overflowRetried = false;

      for (step = 1; step <= settings.maxSteps; step++) {
        signal.throwIfAborted();
        input = await context.prepare(input, instructions, tools);

        lastFlush = Date.now();
        log.debug({ event: "model.started", step });
        // 这里只重试模型请求。完整响应保存成功后，才能执行其中的工具调用。
        let attemptOffset = 0;
        let requestInput = input;
        const requestModel = () =>
          retryModel(
            async (currentAttempt) => {
              attempt = attemptOffset + currentAttempt;

              const request = context.request(input, instructions, tools);
              requestInput = request.input;
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

              return provider.run(
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
          input = await context.prepare(input, instructions, tools, true);

          return requestModel();
        });

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

        const calls = response.output.filter((i) => i.type === "function_call");

        log.info({ event: "model.completed", step, toolCount: calls.length });
        if (!calls.length) {
          if (!response.text) {
            throw new Error("模型未返回文本或工具调用。");
          }

          return;
        }

        for (const call of calls) {
          signal.throwIfAborted();
          const started = Date.now();
          let result: any;

          try {
            const args = JSON.parse(call.arguments);
            currentToolCallId = call.call_id;

            emit("tool_start", { name: call.name, callId: call.call_id, args });
            result =
              call.name === historyDefinition.name
                ? readContextHistory(
                    this.store,
                    session.id,
                    args,
                    settings.outputChars,
                  )
                : await runner.execute(call.name, args);
          } catch (error: any) {
            if (signal.aborted) {
              throw error;
            }

            result = { error: redactText(error.message, [this.config.apiKey]) };
            log.warn({
              event: "tool.failed",
              tool: call.name,
              toolCallId: call.call_id,
            });
          }

          let output = JSON.stringify(result);

          if (output.length > settings.outputChars) {
            output = JSON.stringify({
              truncated: true,
              text: output.slice(0, settings.outputChars),
            });
          }

          output = redactJson(output, [this.config.apiKey]);
          // 文件修改或命令执行已经发生，数据库回滚也撤销不了；结果和上下文要一起保存。
          this.store.transaction(() => {
            emit("tool_result", {
              name: call.name,
              callId: call.call_id,
              result: JSON.parse(output),
              durationMs: Date.now() - started,
            });
            input.push({
              type: "function_call_output",
              call_id: call.call_id,
              output,
            });
            this.store.saveContext(session.id, input);
          });
          log.info({
            event: "tool.completed",
            tool: call.name,
            toolCallId: call.call_id,
            durationMs: Date.now() - started,
            ok:
              !result?.error &&
              (result?.exitCode === undefined || result.exitCode === 0),
          });
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
        errorName: error?.name,
        code: error?.code,
        message: failure,
      });
    } finally {
      this.store.status(task.id, status, failure);
      emit("task_end", { status });
      log.info({ event: "task.finished", status });
    }
  }
}
