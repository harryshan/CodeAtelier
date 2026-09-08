import { prepareTaskContext } from "./context.js";
import { createInstructions } from "./instructions.js";
import { retryModel } from "../providers/retry.js";
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { Store } from "../sessions/store.js";
import { Config } from "../config/config.js";
import { ApprovalManager } from "../permissions/approval-manager.js";
import { ResponsesProvider } from "../providers/responses-provider.js";
import { type ModelProvider } from "../providers/model-provider.js";
import { ToolRunner } from "../tools/tool-runner.js";
import { definitions } from "../tools/registry.js";
import { redactText } from "../logging/redact.js";
import type { Task, TaskStatus } from "../shared/types.js";

export class Engine {
  events = new EventEmitter();
  approvals: ApprovalManager;
  active?: { task: Task; controller: AbortController; done: Promise<void> };

  constructor(
    public store: Store,
    public config: Config,
    private log: Logger,
    private factory?: () => ModelProvider,
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
      redactText(JSON.stringify(data), [this.config.apiKey]),
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

    // 任务与首条消息一起落盘，避免留下没有原始要求的孤立任务。
    const task = this.store.transaction(() => {
      const created = this.store.createTask(sessionId);

      this.emit(created, "user", { text: prompt });
      if (recovery) {
        this.emit(created, "recovery", recovery);
      }

      return created;
    });
    const controller = new AbortController();

    this.active = { task, controller, done: Promise.resolve() };
    this.active.done = this.run(task, prompt, controller.signal)
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
          /* Next boot marks unfinished tasks interrupted. */
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

  private async run(task: Task, prompt: string, signal: AbortSignal) {
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
      const input = prepareTaskContext(this.store, session.id, prompt);

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
        this.factory?.() || new ResponsesProvider(settings, this.config.apiKey);

      for (step = 1; step <= settings.maxSteps; step++) {
        signal.throwIfAborted();
        if (
          JSON.stringify(input).length + instructions.length >
          settings.contextChars
        ) {
          throw new Error("上下文已达到配置上限，请新建会话或提高上下文限制。");
        }

        lastFlush = Date.now();
        log.debug({ event: "model.started", step });
        // 仅重试模型请求；完整响应保存后才允许进入工具执行阶段。
        const response = await retryModel(
          async (currentAttempt) => {
            attempt = currentAttempt;

            return provider.run(
              input,
              instructions,
              definitions,
              signal,
              (delta) => {
                buffer += delta;
                if (Date.now() - lastFlush > 100 || buffer.length > 1000) {
                  flush();
                }
              },
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

        flush();
        signal.throwIfAborted();
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

            emit("tool_start", { name: call.name, callId: call.call_id, args });
            result = await runner.execute(call.name, args);
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

          output = redactText(output, [this.config.apiKey]);
          // 工具已产生的副作用不能回滚；结果与上下文必须一起保存。
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
