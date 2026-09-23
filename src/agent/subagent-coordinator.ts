/*
 * 在主 agent 所在进程协调同任务只读 subagent，供宿主 Engine 与 Sandbox AgentRuntime 共用。
 *
 * 1. execute 校验主 agent 的结构化分工、消息、等待、收集与取消请求；持久化计划先于 Worker。
 * 2. runChild 等待依赖、获取全局租约、启动独立 Worker loop；线程只持有任务描述，模型与
 *    工作区读取在父进程按请求回执重新验证，所有请求和检查点先持久化再确认。
 * 3. stop/close 通知所有未完成子任务，并在退出或强制终止得到确认后归还租约。
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
import { subagentReadDefinitions } from "./subagent-read-contract.js";
import {
  subagentActionSchema,
  type SubtaskPlan,
  type SubagentAction,
} from "./subagent-contracts.js";
import type {
  SubagentParentMessage,
  SubagentWorkerInput,
  SubagentWorkerMessage,
  SubagentWorkerRequest,
} from "./subagent-worker-protocol.js";
import type { SubagentLimits } from "./subagent-limits.js";

type Later<T> = T | Promise<T>;

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

interface ActiveChild {
  controller: AbortController;
  worker?: Worker;
  done: Promise<void>;
}

interface CoordinatorOptions {
  taskId: string;
  workspace: string;
  storage: SubagentStorage;
  provider: ModelProvider;
  limits: Pick<SubagentLimits, "acquire">;
  signal: AbortSignal;
  trace?: (
    name: string,
    subagentId: string,
    status: string,
    durationMs: number,
  ) => void;
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
        // 先登记全部节点，避免向后依赖在协程首个 await 前误判为未创建。
        const entries = request.subtasks.map((plan) => {
          const controller = new AbortController();
          const entry: ActiveChild = { controller, done: Promise.resolve() };
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
      const worker = this.children.get(found.id)?.worker;
      if (!worker || found.status !== "running") {
        return { delivered: false, status: found.status };
      }

      worker.postMessage({
        kind: "message",
        text: request.text,
      } satisfies SubagentParentMessage);

      return { accepted: true, status: found.status };
    }

    if (request.action === "cancel") {
      const found = get(request.subagentId);
      this.stop(found.id);

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
    const pending = request.subagentIds.map(
      (id) => this.children.get(id)?.done ?? Promise.resolve(),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, request.timeoutMs);
    });
    try {
      await Promise.race([Promise.all(pending), timeout]);
    } finally {
      clearTimeout(timer);
    }

    const current = await this.options.storage.subagents(this.options.taskId);

    return {
      subtasks: current
        .filter(({ id }) => request.subagentIds.includes(id))
        .map(({ id, status }) => ({ id, status })),
    };
  }

  private stop(id: string) {
    const active = this.children.get(id);
    if (!active) {
      return;
    }

    active.controller.abort(new Error("subagent 已取消。"));
    active.worker?.postMessage({
      kind: "stop",
    } satisfies SubagentParentMessage);
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
      release = await limits.acquire(taskId, entry.controller.signal);
      entry.controller.signal.throwIfAborted();
      await storage.updateSubagent(taskId, plan.id, "running", []);
      status = await this.startWorker(plan, reader, entry);
    } catch (error) {
      status = entry.controller.signal.aborted ? "cancelled" : "failed";
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
          error instanceof Error
            ? error.message.slice(0, 250)
            : "subagent 启动失败。",
        );
      }
    } finally {
      release?.();
      this.options.trace?.(
        "subagent.worker",
        plan.id,
        status,
        Date.now() - startedAt,
      );
    }
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
      workerData: { ...plan, maxSteps: 12 } satisfies SubagentWorkerInput,
    });
    entry.worker = worker;

    return new Promise((resolve, reject) => {
      let finished:
        Extract<SubagentWorkerMessage, { kind: "finish" }> | undefined;
      worker.on("message", (message: SubagentWorkerMessage) => {
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
          const status = entry.controller.signal.aborted
            ? "cancelled"
            : workerError || code !== 0
              ? "failed"
              : (finished?.status ?? "failed");
          const report =
            finished?.report ??
            workerError?.message.slice(0, 250) ??
            `Worker 未确认结果（exit=${code}）。`;
          await this.options.storage.updateSubagent(
            this.options.taskId,
            plan.id,
            status,
            finished?.status === "completed"
              ? finished.context
              : record.context,
            report,
          );
          resolve(status);
        })().catch(reject);
      });
      entry.controller.signal.addEventListener(
        "abort",
        () =>
          worker.postMessage({ kind: "stop" } satisfies SubagentParentMessage),
        { once: true },
      );
    });
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
              kind: "response",
              id: message.id,
              ok: true,
              result,
            } satisfies SubagentParentMessage)
          : ({
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
        await storage.updateSubagent(taskId, id, "running", checkpoint.context);
        response(true, { ok: true });

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
        await storage.startSubagentRequest(taskId, id, call.requestId, "read");
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

        await storage.finishSubagentRequest(taskId, id, call.requestId, result);
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

      await storage.startSubagentRequest(taskId, id, model.requestId, "model");
      const startedAt = Date.now();
      this.options.trace?.("subagent.model", id, "started", 0);
      this.options.onModelRequest?.(id);
      try {
        const result: ModelResult = await provider.run(
          model.input,
          model.instructions,
          subagentReadDefinitions,
          entry.controller.signal,
          () => {},
          { maxOutputTokens: 2_048 },
        );
        await storage.finishSubagentRequest(
          taskId,
          id,
          model.requestId,
          result,
        );
        if (result.usage) {
          this.options.onUsage?.(id, result.usage);
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
      response(
        false,
        error instanceof Error ? error.message : "subagent 请求失败。",
      );
    }
  }
}
