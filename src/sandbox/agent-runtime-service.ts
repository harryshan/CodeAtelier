/**
 * 在常驻 Agent Runtime 进程内运行模型/工具循环；Broker Host 只通过 Runtime IPC 提供模型、session、审批和项目记忆能力。
 * 本服务不打开宿主 SQLite、不读取模型 endpoint/key，也不创建第二层 SandboxBroker；普通命令和 Git 子进程直接继承 Runtime 的 token/Job。
 *
 * 1. start 接受 Broker 绑定任务的安全设置，恢复 session 上下文并在工作区生成指令和文件工具。
 * 2. ContextManager 在 Runtime 内计量/压缩，快照读写经 RuntimeSessionClient 回到 Broker。
 * 3. 每轮模型调用经 RuntimeModelProvider 代理并保留有界重试/上下文超限恢复；工具 DAG、文件编辑、命令和非 push Git 均由 Runtime 内 ToolRunner 执行。
 * 4. UI/session 事件按单连接顺序排队；无效 DAG 在无副作用时回传模型修正，工具结果保存后才进入下一轮，取消或持久化失败不会盲目重放。
 * 5. 终态同时返回给 start_task 调用方并主动写 runtime_complete；Broker 仍结合进程/Job/ACL 清理决定最终可信状态。
 *
 * Push Runner 必须独占当前工具批次；扩展权限 Runner 可与无依赖的普通工具并行。两者都由结构化 Runtime IPC adapter 等待结果；context/tool/model tracing 经固定 schema 回到 Broker，但提升环境验收仍未完成，不能据此宣称 W3/W4/W5 完成。
 */

import { createBudget } from "../context/token-budget.js";
import {
  ContextManager,
  type ContextTrace,
} from "../context/context-manager.js";
import {
  historyDefinition,
  parseScheduledHistoryArguments,
  readContextHistoryAsync,
} from "../context/history.js";
import { prepareTaskContext } from "../agent/context.js";
import { createInstructions } from "../agent/instructions.js";
import { definitions, parseScheduledToolArguments } from "../tools/registry.js";
import {
  createToolGraph,
  executeToolGraph,
  type ToolGraphNode,
} from "../tools/tool-graph.js";
import { ToolRunner } from "../tools/tool-runner.js";
import { RuntimeIpcError, type RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type {
  RuntimeIpcRequest,
  RuntimeTaskSettings,
} from "./runtime-ipc-protocol.js";
import type { RuntimeExecutionIdentity } from "./runtime-capability-core.js";
import { RuntimeModelProvider } from "./runtime-model-provider.js";
import { retryModel } from "../providers/retry.js";
import { RuntimeSessionClient } from "./runtime-session-client.js";
import {
  RuntimeApprovalClient,
  RuntimeCapabilityClient,
  RuntimeGitPushClient,
  RuntimeMemoryClient,
} from "./runtime-tool-adapters.js";
import { randomUUID } from "node:crypto";

interface StartTaskInput {
  workspace: string;
  prompt: string;
  settings: RuntimeTaskSettings;
  memoryText?: string;
}

type RuntimeTaskStatus = "completed" | "failed" | "cancelled" | "interrupted";

export class AgentRuntimeService {
  private running = false;

  constructor(
    private peer: RuntimeIpcPeer,
    private identity: RuntimeExecutionIdentity,
  ) {
    peer.setRequestHandler((request, signal) => this.handle(request, signal));
  }

  private handle(request: RuntimeIpcRequest, signal: AbortSignal) {
    if (request.operation !== "start_task") {
      throw new RuntimeIpcError("Agent Runtime 只接受 start_task 请求。");
    }

    if (this.running) {
      throw new RuntimeIpcError("Agent Runtime 已有运行中的任务。");
    }

    this.running = true;

    return this.run(request.body, signal).finally(() => {
      this.running = false;
    });
  }

  private async run(input: StartTaskInput, signal: AbortSignal) {
    const session = new RuntimeSessionClient(this.peer, signal);
    const events = new OrderedRuntimeEvents(session);
    const provider = new RuntimeModelProvider(this.peer, "task");
    const compactionProvider = new RuntimeModelProvider(
      this.peer,
      "compaction",
    );
    const trace = new RuntimeContextTrace(this.peer);
    let status: RuntimeTaskStatus = "completed";
    let failure: string | undefined;

    try {
      const modelInput = await prepareTaskContext(
        session,
        this.identity.sessionId,
        input.prompt,
      );
      const instructions = [
        await createInstructions(input.workspace, undefined, true),
        input.memoryText,
      ]
        .filter(Boolean)
        .join("\n\n");
      const capabilities = await provider.getCapabilities(signal);
      const budget = createBudget(
        capabilities,
        input.settings.contextChars,
        input.settings.maxOutputTokens,
      );
      const toolSettings = runtimeToolSettings(input.settings);
      const gitPush = new RuntimeGitPushClient(this.peer);
      const capability = new RuntimeCapabilityClient(this.peer);
      const runner = new ToolRunner({
        root: input.workspace,
        sessionId: this.identity.sessionId,
        taskId: this.identity.taskId,
        signal,
        settings: toolSettings,
        approvals: new RuntimeApprovalClient(this.peer),
        memory: new RuntimeMemoryClient(this.peer, signal),
        gitPush: (spec, pushSignal, toolCallId) => {
          if (!toolCallId) {
            throw new Error("Push Runner 请求缺少工具调用标识。");
          }

          return gitPush.execute(spec, toolCallId, pushSignal);
        },
        runWithPermissions: (request, requestSignal, toolCallId) => {
          if (!toolCallId) {
            throw new Error("扩展权限请求缺少工具调用标识。");
          }

          return capability.execute(request, toolCallId, requestSignal);
        },
        executionBoundary: "agent-runtime",
        parentExecutionInstanceId: this.identity.executionInstanceId,
        emit: (type, data) => events.emit(type, data),
      });
      const tools = [...definitions, historyDefinition];
      const context = new ContextManager({
        store: session,
        sessionId: this.identity.sessionId,
        model: input.settings.model,
        limit: budget.limit,
        currentFileHash: (file) => runner.currentFileHash(file),
        measure: budget.measure,
        measurement: budget.measurement,
        unit: budget.unit,
        maxOutputTokens: budget.outputTokens,
        provider: compactionProvider,
        signal,
        clean: (text) => text,
        notice: (text) => events.emit("notice", { text }),
        report: (event, data) => events.emit(event, data),
        trace,
        onModelRequest: () =>
          events.emit("model_request", { purpose: "compaction" }),
        onUsage: (usage) =>
          events.emit("model_usage", { ...usage, purpose: "compaction" }),
      });
      let currentInput = modelInput;
      let overflowRetried = false;

      this.peer.event({
        type: "event",
        event: "runtime_state",
        state: "running",
      });
      for (let step = 1; step <= input.settings.maxSteps; step++) {
        signal.throwIfAborted();
        const prepareSpan = trace.start("context.prepare", { step });
        try {
          currentInput = await context.prepare(
            currentInput,
            instructions,
            tools,
          );
          trace.end(prepareSpan, "ok", { inputItems: currentInput.length });
        } catch (error) {
          trace.end(prepareSpan, signal.aborted ? "cancelled" : "error", {
            errorName: error instanceof Error ? error.name : typeof error,
          });
          throw error;
        }

        let requestInput = currentInput;
        let attemptOffset = 0;
        let attempt = 0;
        const requestModel = () =>
          retryModel(
            async (currentAttempt) => {
              attempt = attemptOffset + currentAttempt;
              const requestSpan = trace.start("context.request", {
                step,
                attempt,
              });
              try {
                requestInput = context.request(
                  currentInput,
                  instructions,
                  tools,
                ).input;
                trace.end(requestSpan, "ok", {
                  inputItems: requestInput.length,
                });
              } catch (error) {
                trace.end(requestSpan, signal.aborted ? "cancelled" : "error", {
                  errorName: error instanceof Error ? error.name : typeof error,
                });
                throw error;
              }

              events.emit("model_request", { purpose: "task", step, attempt });

              return provider.run(
                requestInput,
                instructions,
                tools,
                signal,
                (text) => events.emit("delta", { text, step, attempt }),
                { maxOutputTokens: budget.outputTokens },
              );
            },
            signal,
            (error, failedAttempt, delayMs) =>
              events.emit("notice", {
                text: `${error.message} ${delayMs} ms 后重试（${failedAttempt}/2）。`,
                code: error.code,
                step,
                attempt,
              }),
          );
        const response = await requestModel().catch(async (error) => {
          if (error?.code !== "context_length_exceeded" || overflowRetried) {
            throw error;
          }

          attemptOffset = attempt;
          overflowRetried = true;
          currentInput = await context.prepare(
            currentInput,
            instructions,
            tools,
            true,
          );

          return requestModel();
        });
        if (response.usage) {
          budget.observeUsage?.(
            response.usage.input_tokens,
            requestInput,
            instructions,
            tools,
          );
          events.emit("model_usage", {
            ...response.usage,
            purpose: "task",
            step,
            attempt,
          });
        }

        currentInput.push(...response.output);
        await session.saveContext(this.identity.sessionId, currentInput);
        if (response.text) {
          events.emit("assistant", { text: response.text, step, attempt });
        }

        const calls = response.output.filter(
          (item: any) => item.type === "function_call",
        );
        if (!calls.length) {
          if (!response.text) {
            throw new Error("模型未返回文本或工具调用。");
          }

          await events.flush();
          break;
        }

        const batchId = randomUUID();
        let graph;
        try {
          graph = buildRuntimeToolGraph(calls);
        } catch (error) {
          const message =
            error instanceof Error ? error.message.slice(0, 2_000) : "未知错误";

          for (const [ordinal, call] of calls.entries()) {
            const result = { error: `工具调用图无效：${message}` };

            events.emit("tool_start", {
              name: call.name,
              callId: call.call_id,
              batchId,
              nodeId: `invalid-${ordinal + 1}`,
              dependsOn: [],
              args: call.arguments,
            });
            currentInput.push({
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify(result),
            });
            events.emit("tool_result", {
              name: call.name,
              callId: call.call_id,
              batchId,
              nodeId: `invalid-${ordinal + 1}`,
              result,
            });
          }

          await session.saveContext(this.identity.sessionId, currentInput);
          await events.flush();

          continue;
        }

        events.emit("tool_batch_planned", {
          batchId,
          nodes: graph.nodes.map((node) => ({
            callId: node.callId,
            nodeId: node.nodeId,
            name: node.name,
            dependsOn: node.dependsOn,
            ordinal: node.ordinal,
          })),
        });
        const persistence = new OrderedContextPersistence(
          session,
          this.identity.sessionId,
          currentInput,
          input.settings.outputChars,
          events,
          batchId,
        );
        await executeToolGraph(graph, {
          execute: async (node) => {
            signal.throwIfAborted();
            events.emit("tool_start", {
              name: node.name,
              callId: node.callId,
              batchId,
              nodeId: node.nodeId,
              dependsOn: node.dependsOn,
              args: node.arguments,
            });
            let result: unknown;
            try {
              result =
                node.name === historyDefinition.name
                  ? await readContextHistoryAsync(
                      session,
                      this.identity.sessionId,
                      node.arguments,
                      input.settings.outputChars,
                    )
                  : await runner
                      .forCall(node.callId)
                      .execute(node.name, node.arguments);
            } catch (error) {
              signal.throwIfAborted();
              result = {
                error:
                  error instanceof Error
                    ? error.message.slice(0, 2_000)
                    : "工具执行失败。",
              };
            }

            await persistence.save(node, result);

            return toolSucceeded(result);
          },
          block: async (node, failedDependency) => {
            await persistence.save(node, {
              error: `依赖工具 ${failedDependency.nodeId} 未成功，未执行当前调用。`,
              code: "dependency_failed",
              failedDependency: failedDependency.nodeId,
            });
          },
          state: (node, state) =>
            events.emit("tool_state", {
              batchId,
              nodeId: node.nodeId,
              callId: node.callId,
              state,
            }),
        });
        await persistence.flush();
        await events.flush();

        if (step === input.settings.maxSteps) {
          throw new Error("已达到最大模型调用次数，任务停止。");
        }
      }
    } catch (error) {
      status = signal.aborted ? "cancelled" : "failed";
      failure = signal.aborted
        ? "任务已取消，可手动恢复。"
        : error instanceof Error
          ? error.message.slice(0, 2_000)
          : "任务失败。";
      events.emit("notice", { text: failure, status });
    }

    await events.flush();
    await this.peer.request(
      "runtime_complete",
      { status, failure },
      AbortSignal.timeout(10_000),
    );
    this.peer.event({
      type: "event",
      event: "runtime_state",
      state: "stopping",
    });

    return { status, failure };
  }
}

function runtimeToolSettings(settings: RuntimeTaskSettings) {
  return {
    baseUrl: "broker://model",
    model: settings.model,
    maxSteps: settings.maxSteps,
    maxConcurrentTasks: 1,
    commandTimeoutMs: settings.commandTimeoutMs,
    requestTimeoutMs: 300_000,
    idleTimeoutMs: 60_000,
    maxOutputTokens: settings.maxOutputTokens,
    contextChars: settings.contextChars,
    outputChars: settings.outputChars,
    logLevel: "info",
  };
}

export function buildRuntimeToolGraph(calls: any[]) {
  const nodes = calls.map((call, ordinal) => {
    const raw = JSON.parse(call.arguments);
    const scheduled =
      call.name === historyDefinition.name
        ? parseScheduledHistoryArguments(raw, `call-${ordinal + 1}`)
        : parseScheduledToolArguments(call.name, raw, `call-${ordinal + 1}`);

    return {
      callId: call.call_id,
      nodeId: scheduled.execution.id,
      name: call.name,
      arguments: scheduled.arguments,
      dependsOn: scheduled.execution.dependsOn,
      ordinal,
    };
  });
  const containsPush = nodes.some(
    (node) =>
      node.name === "git" &&
      ((node.arguments as any).action === "push" ||
        (node.arguments as any).request?.action === "push"),
  );
  if (containsPush && nodes.length !== 1) {
    throw new Error("Git push 必须是当前工具批次的唯一调用。");
  }

  return createToolGraph(nodes);
}

function toolSucceeded(result: any) {
  return (
    !result?.error &&
    (result?.exitCode === undefined || result.exitCode === 0) &&
    !result?.files?.some(
      (file: any) => file.status === "failed" || file.status === "unknown",
    )
  );
}

/** Runtime 只可上报固定 context 阶段和有界数值元数据；协议 schema 会拒绝任意名称或文本属性。 */
class RuntimeContextTrace implements ContextTrace {
  private stack: string[] = [];

  constructor(private peer: RuntimeIpcPeer) {}

  start(
    name: string,
    attributes: Record<string, boolean | number | string | undefined> = {},
  ) {
    const spanId = randomUUID();
    const parentSpanId = this.stack.at(-1);
    this.peer.event({
      type: "event",
      event: "trace_span_start",
      spanId,
      parentSpanId,
      name: name as
        | "context.prepare"
        | "context.prepare.measure_request_view"
        | "context.request"
        | "context.request.measure_input",
      attributes,
    });
    this.stack.push(spanId);

    return spanId;
  }

  end(
    handle: unknown,
    status: "cancelled" | "error" | "ok",
    attributes: Record<string, boolean | number | string | undefined> = {},
  ) {
    if (typeof handle !== "string") {
      throw new Error("Agent Runtime trace span handle 无效。");
    }

    const index = this.stack.lastIndexOf(handle);
    if (index < 0) {
      throw new Error("Agent Runtime trace span 已结束或不存在。");
    }

    this.stack.splice(index, 1);
    this.peer.event({
      type: "event",
      event: "trace_span_end",
      spanId: handle,
      status,
      attributes,
    });
  }

  currentSpanId() {
    return this.stack.at(-1);
  }
}

class OrderedRuntimeEvents {
  private pending = Promise.resolve();

  constructor(private session: RuntimeSessionClient) {}

  emit(type: string, data: unknown) {
    this.pending = this.pending.then(() =>
      this.session.appendEvent(type, data),
    );
  }

  flush() {
    return this.pending;
  }
}

class OrderedContextPersistence {
  private pending = Promise.resolve();

  constructor(
    private session: RuntimeSessionClient,
    private sessionId: string,
    private input: any[],
    private outputChars: number,
    private events: OrderedRuntimeEvents,
    private batchId: string,
  ) {}

  save(node: ToolGraphNode, result: unknown) {
    this.pending = this.pending.then(async () => {
      let output = JSON.stringify(result);
      if (output.length > this.outputChars) {
        output = JSON.stringify({
          truncated: true,
          text: output.slice(0, this.outputChars),
        });
      }

      this.events.emit("tool_result", {
        name: node.name,
        callId: node.callId,
        batchId: this.batchId,
        nodeId: node.nodeId,
        result,
      });
      this.input.push({
        type: "function_call_output",
        call_id: node.callId,
        output,
      });
      await this.session.saveContext(this.sessionId, this.input);
    });

    return this.pending;
  }

  flush() {
    return this.pending;
  }
}
