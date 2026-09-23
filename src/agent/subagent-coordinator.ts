/*
 * 在主 agent 所在进程协调同任务只读 subagent，供宿主 Engine 与 Sandbox AgentRuntime 共用。
 *
 * 1. execute 校验分工/等待/回复/收集/取消；子问题先持久化再唤醒主代理，不让子任务直接访问另一 Worker，消息 trace 只含安全 ID。
 * 2. runChild 等待依赖、获取全局租约，按时限和实报 token 上限驱动独立 Worker loop；逐方向核对消息归属/序号，模型与读取经父进程验证并先落盘。
 * 3. stop/close 通知所有未完成子任务，并在退出或强制终止得到确认后归还租约；等待响应主任务取消，消息数有界。
 * 4. Broker/Store 检查点或请求结果持久化失败时终止 Worker，不能将未知的只读结果当成普通工具失败后继续模型轮次。
 *
 * 这是模型工具层的只读约束而非线程 OS 沙箱；未知执行结果不能被重放。
 */

import { Worker } from "node:worker_threads";
import { z } from "zod";
import type {
  ModelProvider,
  ModelResult,
} from "../providers/model-provider.js";
import type { ModelUsage } from "../providers/model-metadata.js";
import type { SubagentRecord, SubagentStatus } from "../shared/types.js";
import { SubagentReadOnly } from "../tools/subagent-readonly.js";
import { subagentToolDefinitions } from "./subagent-question-contract.js";
import {
  subagentActionSchema,
  type SubtaskPlan,
  type SubagentAction,
} from "./subagent-contracts.js";
import { SUBAGENT_WORKER_PROTOCOL_VERSION } from "./subagent-worker-protocol.js";
import type {
  SubagentMessageEnvelope,
  SubagentParentMessage,
  SubagentWorkerInput,
  SubagentWorkerMessage,
  SubagentWorkerRequest,
} from "./subagent-worker-protocol.js";

type Later<T> = T | Promise<T>;

export interface SubagentQuestionReceipt {
  id: number;
  subagentId: string;
  question: string;
}

class SubagentPersistenceError extends Error {
  constructor(cause: unknown) {
    super("subagent 请求或检查点未能持久化，结果未知。", { cause });
    this.name = "SubagentPersistenceError";
  }
}

export interface SubagentStorage {
  planSubagents(taskId: string, plans: SubtaskPlan[]): Later<SubagentRecord[]>;
  subagents(taskId: string): Later<SubagentRecord[]>;
  updateSubagent(
    taskId: string,
    id: string,
    status: SubagentStatus,
    context: unknown[],
    report?: string,
  ): Later<unknown>;
  startSubagentRequest(
    taskId: string,
    subagentId: string,
    requestId: string,
    kind: string,
  ): Later<unknown>;
  finishSubagentRequest(
    taskId: string,
    subagentId: string,
    requestId: string,
    result: unknown,
  ): Later<unknown>;
  recordSubagentQuestion(
    taskId: string,
    subagentId: string,
    requestId: string,
    question: string,
  ): Later<SubagentQuestionReceipt>;
  collectSubagents(
    taskId: string,
    ids: string[],
  ): Later<
    Array<{
      id: string;
      status: SubagentStatus;
      report: string | null;
      consumed: boolean;
    }>
  >;
}

const MAX_CHILD_RUNTIME_MS = 120_000;
const MAX_CHILD_TOKENS = 32_000;
const BUDGET_TERMINATION_GRACE_MS = 5_000;

type ChildBudgetFailure = "duration" | "tokens";

function budgetFailureMessage(failure: ChildBudgetFailure | undefined) {
  if (failure === "duration") {
    return "subagent 运行时间超过上限，已停止。";
  }

  return failure === "tokens"
    ? "subagent 累计 token 用量超过上限，已停止。"
    : undefined;
}

interface ActiveChild {
  controller: AbortController;
  worker?: Worker;
  done: Promise<void>;
  messagesSent: number;
  questionsSent: number;
  questionRequests: Map<string, SubagentQuestionReceipt>;
  parentSequence: number;
  childSequence: number;
  usedTokens: number;
  budgetFailure?: ChildBudgetFailure;
  terminateTimer?: NodeJS.Timeout;
}

interface CoordinatorOptions {
  taskId: string;
  workspace: string;
  storage: SubagentStorage;
  provider: ModelProvider;
  limits: {
    acquire(
      taskId: string,
      signal: AbortSignal,
      subagentId?: string,
    ): Promise<() => void | Promise<void>>;
  };
  providerFor?: (subagentId: string, requestId: string) => ModelProvider;
  maxChildDurationMs?: number;
  maxChildTokens?: number;
  signal: AbortSignal;
  trace?: (
    name: string,
    subagentId: string,
    status: string,
    durationMs: number,
  ) => void;
  onStateChange?: () => void;
  onModelRequest?: (subagentId: string) => void;
  onUsage?: (subagentId: string, usage: ModelUsage) => void;
}

function workerSource() {
  if (import.meta.url.endsWith(".ts")) {
    return new URL("./subagent-worker.ts", import.meta.url);
  }

  if (import.meta.url.endsWith(".mjs")) {
    return new URL("./subagent-worker.mjs", import.meta.url);
  }

  return new URL("./subagent-worker.js", import.meta.url);
}

export class SubagentCoordinator {
  private readonly children = new Map<string, ActiveChild>();
  private readonly pendingQuestions = new Map<
    number,
    SubagentQuestionReceipt
  >();

  private readonly questionWaiters = new Set<{
    ids: string[];
    resolve: () => void;
  }>();

  /** close 等待已开始登记的计划后再收集 Worker，不能漏掉跨 await 才创建的子任务。 */
  private readonly pendingPlans = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: CoordinatorOptions) {
    options.signal.addEventListener(
      "abort",
      () => {
        for (const id of this.children.keys()) {
          this.stop(id);
        }
      },
      { once: true },
    );
  }

  async execute(action: SubagentAction) {
    const request = subagentActionSchema.parse({ request: action }).request;
    if (this.closed || this.options.signal.aborted) {
      throw new Error("主任务已经停止，不能继续协调 subagent。");
    }

    if (request.action === "plan") {
      const pending = (async () => {
        const readers = await Promise.all(
          request.subtasks.map((plan) =>
            SubagentReadOnly.create(
              this.options.workspace,
              plan.scope,
              this.options.signal,
            ),
          ),
        );
        const records = await this.options.storage.planSubagents(
          this.options.taskId,
          request.subtasks,
        );
        this.options.onStateChange?.();
        // 先登记全部节点，避免向后依赖在协程首个 await 前误判为未创建。
        const entries = request.subtasks.map((plan) => {
          const controller = new AbortController();
          const entry: ActiveChild = {
            controller,
            done: Promise.resolve(),
            messagesSent: 0,
            questionsSent: 0,
            questionRequests: new Map(),
            parentSequence: 0,
            childSequence: 0,
            usedTokens: 0,
          };
          this.children.set(plan.id, entry);

          return entry;
        });
        for (const [index, plan] of request.subtasks.entries()) {
          const entry = entries[index];
          // 下一微任务再启动，确保所有 done Promise 均已绑定到真正的依赖协程。
          entry.done = Promise.resolve().then(() =>
            this.runChild(plan, readers[index], entry),
          );
          void entry.done.catch(() => {}); // close 会收集错误；提前附加处理防止未等待的 Promise 被进程视作未处理拒绝。
        }

        return { subtasks: records.map(({ id, status }) => ({ id, status })) };
      })();
      this.pendingPlans.add(pending);
      try {
        return await pending;
      } finally {
        this.pendingPlans.delete(pending);
      }
    }

    const agents = await this.options.storage.subagents(this.options.taskId);
    const get = (id: string) => {
      const found = agents.find((record) => record.id === id);
      if (!found) {
        throw new Error("subagent 不属于本任务。");
      }

      return found;
    };

    if (request.action === "message") {
      const found = get(request.subagentId);
      const active = this.children.get(found.id);
      const worker = active?.worker;
      if (!active || !worker || found.status !== "running") {
        return { delivered: false, status: found.status };
      }

      if (active.messagesSent >= 16) {
        throw new Error("subagent 消息上限为每个子任务 16 条。");
      }

      if (request.replyTo !== undefined) {
        const question = this.pendingQuestions.get(request.replyTo);
        if (question?.subagentId !== found.id) {
          throw new Error("回复不属于当前子任务或已经答复。");
        }
      }

      const startedAt = Date.now();
      this.options.trace?.("subagent.message", found.id, "started", 0);
      try {
        active.messagesSent++;
        worker.postMessage({
          ...this.envelope(found.id, active),
          kind: "message",
          text: request.text,
          replyTo: request.replyTo,
        } satisfies SubagentParentMessage);
        if (request.replyTo !== undefined) {
          this.pendingQuestions.delete(request.replyTo);
        }

        this.options.trace?.(
          "subagent.message",
          found.id,
          "ok",
          Date.now() - startedAt,
        );
      } catch (error) {
        this.options.trace?.(
          "subagent.message",
          found.id,
          "error",
          Date.now() - startedAt,
        );
        throw error;
      }

      return { accepted: true, status: found.status };
    }

    if (request.action === "cancel") {
      const found = get(request.subagentId);
      const startedAt = Date.now();
      this.options.trace?.("subagent.cancel", found.id, "started", 0);
      try {
        this.stop(found.id);
        this.options.trace?.(
          "subagent.cancel",
          found.id,
          "cancelled",
          Date.now() - startedAt,
        );
      } catch (error) {
        this.options.trace?.(
          "subagent.cancel",
          found.id,
          "error",
          Date.now() - startedAt,
        );
        throw error;
      }

      return { id: found.id, status: "cancelling" };
    }

    if (request.action === "collect") {
      request.subagentIds.forEach(get);

      return {
        reports: await this.options.storage.collectSubagents(
          this.options.taskId,
          request.subagentIds,
        ),
      };
    }

    request.subagentIds.forEach(get);
    this.options.signal.throwIfAborted();
    const waiter = { ids: request.subagentIds, resolve: () => {} };
    const questionArrived = new Promise<void>((resolve) => {
      waiter.resolve = resolve;
    });
    this.questionWaiters.add(waiter);
    const pending = request.subagentIds.map(
      (id) => this.children.get(id)?.done ?? Promise.resolve(),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, request.timeoutMs);
    });
    let abortWaiting!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortWaiting = () =>
        reject(this.options.signal.reason ?? new Error("主任务已取消。"));
      this.options.signal.addEventListener("abort", abortWaiting, {
        once: true,
      });
    });
    try {
      this.options.signal.throwIfAborted();
      if (!this.questionsFor(request.subagentIds).length) {
        await Promise.race([
          Promise.all(pending),
          timeout,
          aborted,
          questionArrived,
        ]);
      }

      this.options.signal.throwIfAborted();
    } finally {
      this.questionWaiters.delete(waiter);
      this.options.signal.removeEventListener("abort", abortWaiting);
      clearTimeout(timer);
    }

    const current = await this.options.storage.subagents(this.options.taskId);

    return {
      subtasks: current
        .filter(({ id }) => request.subagentIds.includes(id))
        .map(({ id, status }) => ({ id, status })),
      questions: this.questionsFor(request.subagentIds),
    };
  }

  private questionsFor(ids: readonly string[]) {
    // 每轮至多交付四条；主代理回复后再调用 await 可读取下一批，避免模型反馈被截断。
    return [...this.pendingQuestions.values()]
      .filter((question) => ids.includes(question.subagentId))
      .slice(0, 4);
  }

  private exhaustBudget(entry: ActiveChild, failure: ChildBudgetFailure) {
    if (entry.controller.signal.aborted) {
      return;
    }

    entry.budgetFailure = failure;
    entry.controller.abort(new Error(budgetFailureMessage(failure)));
    // 模型代理不响应取消时，仍须确认 Worker 退出才允许归还活动租约。
    entry.terminateTimer = setTimeout(() => {
      if (entry.worker) {
        void entry.worker.terminate();
      }
    }, BUDGET_TERMINATION_GRACE_MS);
  }

  private stop(id: string) {
    const active = this.children.get(id);
    if (!active) {
      return;
    }

    // 已启动的 Worker 由 startWorker 注册的 abort listener 只接收一次 stop。
    active.controller.abort(new Error("subagent 已取消。"));
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pendingPlans]);
    for (const id of this.children.keys()) {
      this.stop(id);
    }

    const timer = setTimeout(() => {
      for (const entry of this.children.values()) {
        if (entry.worker) {
          void entry.worker.terminate();
        }
      }
    }, 5_000);
    try {
      await Promise.all([...this.children.values()].map(({ done }) => done));
    } finally {
      clearTimeout(timer);
    }
  }

  private async runChild(
    plan: SubtaskPlan,
    reader: SubagentReadOnly,
    entry: ActiveChild,
  ) {
    const startedAt = Date.now();
    const { taskId, storage, limits } = this.options;
    let release: (() => void) | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let status: SubagentStatus = "failed";
    this.options.trace?.("subagent.worker", plan.id, "started", 0);
    try {
      for (const parent of plan.dependsOn) {
        await this.children.get(parent)?.done;
        const dependency = (await storage.subagents(taskId)).find(
          ({ id }) => id === parent,
        );
        if (dependency?.status !== "completed") {
          throw new Error("依赖 subagent 未成功，不启动后继 Worker。");
        }
      }

      entry.controller.signal.throwIfAborted();
      await storage.updateSubagent(taskId, plan.id, "queued", []);
      this.options.onStateChange?.();
      release = await limits.acquire(taskId, entry.controller.signal, plan.id);
      entry.controller.signal.throwIfAborted();
      await storage.updateSubagent(taskId, plan.id, "running", []);
      this.options.onStateChange?.();
      deadline = setTimeout(
        () => this.exhaustBudget(entry, "duration"),
        Math.min(
          this.options.maxChildDurationMs ?? MAX_CHILD_RUNTIME_MS,
          MAX_CHILD_RUNTIME_MS,
        ),
      );
      status = await this.startWorker(plan, reader, entry);
    } catch (error) {
      status = entry.budgetFailure
        ? "failed"
        : entry.controller.signal.aborted
          ? "cancelled"
          : "failed";
      const record = (await storage.subagents(taskId)).find(
        ({ id }) => id === plan.id,
      );
      if (
        record &&
        !["completed", "failed", "cancelled", "interrupted"].includes(
          record.status,
        )
      ) {
        await storage.updateSubagent(
          taskId,
          plan.id,
          status,
          record.context,
          budgetFailureMessage(entry.budgetFailure) ??
            (error instanceof Error
              ? error.message.slice(0, 250)
              : "subagent 启动失败。"),
        );
        this.options.onStateChange?.();
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(entry.terminateTimer);
      await release?.();
      this.options.trace?.(
        "subagent.worker",
        plan.id,
        status,
        Date.now() - startedAt,
      );
    }
  }

  private envelope(id: string, entry: ActiveChild): SubagentMessageEnvelope {
    return {
      version: SUBAGENT_WORKER_PROTOCOL_VERSION,
      taskId: this.options.taskId,
      subagentId: id,
      sequence: ++entry.parentSequence,
    };
  }

  private startWorker(
    plan: SubtaskPlan,
    reader: SubagentReadOnly,
    entry: ActiveChild,
  ): Promise<SubagentStatus> {
    const source = workerSource();
    const worker = new Worker(source, {
      execArgv: source.pathname.endsWith(".ts")
        ? ["--import", "tsx"]
        : undefined,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: process.env.PATH ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      },
      workerData: {
        ...plan,
        taskId: this.options.taskId,
        maxSteps: 12,
      } satisfies SubagentWorkerInput,
    });
    entry.worker = worker;

    return new Promise((resolve, reject) => {
      let finished:
        Extract<SubagentWorkerMessage, { kind: "finish" }> | undefined;
      worker.on("message", (message: SubagentWorkerMessage) => {
        if (
          !message ||
          message.version !== SUBAGENT_WORKER_PROTOCOL_VERSION ||
          message.taskId !== this.options.taskId ||
          message.subagentId !== plan.id ||
          !Number.isSafeInteger(message.sequence) ||
          message.sequence !== entry.childSequence + 1 ||
          (message.kind !== "finish" && message.kind !== "request")
        ) {
          workerError = new Error("subagent Worker 消息版本、归属或序号无效。");
          void worker.terminate();

          return;
        }

        entry.childSequence = message.sequence;
        if (message.kind === "finish") {
          finished = message;

          return;
        }

        void this.respond(plan.id, reader, entry, worker, message).catch(
          (error) => {
            workerError =
              error instanceof Error ? error : new Error("subagent 请求失败。");
            void worker.terminate();
          },
        );
      });
      let workerError: Error | undefined;
      worker.once("error", (error) => {
        workerError = error;
      });
      worker.once("exit", (code) => {
        entry.worker = undefined;
        void (async () => {
          const record = (
            await this.options.storage.subagents(this.options.taskId)
          ).find(({ id }) => id === plan.id);
          if (!record) {
            throw new Error("subagent 在退出时失去任务归属。");
          }

          // 取消可能先于 Worker 对模型/工具错误的回执，终态不能误写为 failed。
          const status = entry.budgetFailure
            ? "failed"
            : entry.controller.signal.aborted
              ? "cancelled"
              : workerError || code !== 0
                ? "failed"
                : (finished?.status ?? "failed");
          const report =
            budgetFailureMessage(entry.budgetFailure) ??
            finished?.report ??
            workerError?.message.slice(0, 250) ??
            `Worker 未确认结果（exit=${code}）。`;
          await this.options.storage.updateSubagent(
            this.options.taskId,
            plan.id,
            status,
            status === "completed" && finished?.status === "completed"
              ? finished.context
              : record.context,
            report,
          );
          this.options.onStateChange?.();
          resolve(status);
        })().catch(reject);
      });
      entry.controller.signal.addEventListener(
        "abort",
        () => {
          if (entry.worker === worker) {
            worker.postMessage({
              ...this.envelope(plan.id, entry),
              kind: "stop",
            } satisfies SubagentParentMessage);
          }
        },
        { once: true },
      );
    });
  }

  private async persist<T>(operation: () => Later<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new SubagentPersistenceError(error);
    }
  }

  private async respond(
    id: string,
    reader: SubagentReadOnly,
    entry: ActiveChild,
    worker: Worker,
    message: SubagentWorkerRequest,
  ) {
    const { taskId, storage, provider } = this.options;
    const response = (ok: boolean, result: unknown) => {
      if (entry.worker !== worker) {
        return;
      }

      worker.postMessage(
        ok
          ? ({
              ...this.envelope(id, entry),
              kind: "response",
              id: message.id,
              ok: true,
              result,
            } satisfies SubagentParentMessage)
          : ({
              ...this.envelope(id, entry),
              kind: "response",
              id: message.id,
              ok: false,
              error: String(result).slice(0, 250),
            } satisfies SubagentParentMessage),
      );
    };

    try {
      entry.controller.signal.throwIfAborted();
      if (message.operation === "checkpoint") {
        const checkpoint = z
          .object({
            status: z.literal("running"),
            context: z.array(z.unknown()).max(2000),
          })
          .strict()
          .parse(message.payload);
        await this.persist(() =>
          storage.updateSubagent(taskId, id, "running", checkpoint.context),
        );
        response(true, { ok: true });

        return;
      }

      if (message.operation === "question") {
        const question = z
          .object({
            requestId: z.string().min(1).max(120),
            question: z.string().trim().min(1).max(1_000),
          })
          .strict()
          .parse(message.payload);
        const previous = entry.questionRequests.get(question.requestId);
        if (previous) {
          if (previous.question !== question.question) {
            throw new Error("subagent 问题请求 ID 对应的内容已改变。");
          }

          response(true, { id: previous.id, queued: true });

          return;
        }

        if (entry.questionsSent >= 8) {
          throw new Error("每个 subagent 最多向主代理提问 8 次。");
        }

        const startedAt = Date.now();
        this.options.trace?.("subagent.question", id, "started", 0);
        try {
          const receipt = await this.persist(() =>
            storage.recordSubagentQuestion(
              taskId,
              id,
              question.requestId,
              question.question,
            ),
          );
          if (!this.pendingQuestions.has(receipt.id)) {
            entry.questionsSent++;
            this.pendingQuestions.set(receipt.id, receipt);
            for (const waiter of this.questionWaiters) {
              if (waiter.ids.includes(id)) {
                waiter.resolve();
              }
            }
          }

          entry.questionRequests.set(question.requestId, receipt);
          this.options.onStateChange?.();
          this.options.trace?.(
            "subagent.question",
            id,
            "ok",
            Date.now() - startedAt,
          );
          response(true, { id: receipt.id, queued: true });
        } catch (error) {
          this.options.trace?.(
            "subagent.question",
            id,
            "error",
            Date.now() - startedAt,
          );
          throw error;
        }

        return;
      }

      if (message.operation === "read") {
        const call = z
          .object({
            requestId: z.string().min(1).max(128),
            name: z.string(),
            arguments: z.unknown(),
          })
          .strict()
          .parse(message.payload);
        await this.persist(() =>
          storage.startSubagentRequest(taskId, id, call.requestId, "read"),
        );
        const readStarted = Date.now();
        this.options.trace?.("subagent.tool.read", id, "started", 0);
        let result: unknown;
        try {
          result = await reader.execute(call.name, call.arguments);
        } catch (error) {
          result = {
            error:
              error instanceof Error
                ? error.message.slice(0, 250)
                : "读取失败。",
          };
        }

        try {
          await this.persist(() =>
            storage.finishSubagentRequest(taskId, id, call.requestId, result),
          );
        } catch (error) {
          this.options.trace?.(
            "subagent.tool.read",
            id,
            "error",
            Date.now() - readStarted,
          );
          throw error;
        }

        this.options.trace?.(
          "subagent.tool.read",
          id,
          result && typeof result === "object" && "error" in result
            ? "error"
            : "ok",
          Date.now() - readStarted,
        );
        response(true, result);

        return;
      }

      if (message.operation !== "model") {
        throw new Error("未知 subagent Worker 请求。");
      }

      const model = z
        .object({
          requestId: z.string().min(1).max(128),
          input: z.array(z.unknown()),
          instructions: z.string().max(2_000),
        })
        .passthrough()
        .parse(message.payload);
      if (JSON.stringify(model.input).length > 100_000) {
        throw new Error("subagent 模型输入超出安全预算。");
      }

      await this.persist(() =>
        storage.startSubagentRequest(taskId, id, model.requestId, "model"),
      );
      const startedAt = Date.now();
      this.options.trace?.("subagent.model", id, "started", 0);
      this.options.onModelRequest?.(id);
      try {
        const selectedProvider =
          this.options.providerFor?.(id, model.requestId) ?? provider;
        const result: ModelResult = await selectedProvider.run(
          model.input,
          model.instructions,
          subagentToolDefinitions,
          entry.controller.signal,
          () => {},
          { maxOutputTokens: 2_048 },
        );
        await this.persist(() =>
          storage.finishSubagentRequest(taskId, id, model.requestId, result),
        );
        if (result.usage) {
          this.options.onUsage?.(id, result.usage);
          const tokens = result.usage.total_tokens;
          if (Number.isSafeInteger(tokens) && tokens >= 0) {
            entry.usedTokens += tokens;
          }
        }

        if (
          entry.usedTokens >
          Math.min(
            this.options.maxChildTokens ?? MAX_CHILD_TOKENS,
            MAX_CHILD_TOKENS,
          )
        ) {
          this.exhaustBudget(entry, "tokens");
          this.options.trace?.(
            "subagent.model",
            id,
            "error",
            Date.now() - startedAt,
          );

          return;
        }

        this.options.trace?.(
          "subagent.model",
          id,
          "ok",
          Date.now() - startedAt,
        );
        response(true, result);
      } catch (error) {
        this.options.trace?.(
          "subagent.model",
          id,
          entry.controller.signal.aborted ? "cancelled" : "error",
          Date.now() - startedAt,
        );
        throw error;
      }
    } catch (error) {
      if (error instanceof SubagentPersistenceError) {
        throw error;
      }

      response(
        false,
        error instanceof Error ? error.message : "subagent 请求失败。",
      );
    }
  }
}
