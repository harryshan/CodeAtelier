/**
 * 在常驻 Agent Runtime 进程内运行模型/工具循环；Broker Host 只通过 Runtime IPC 提供模型、session、审批和项目记忆能力。
 * 本服务不打开宿主 SQLite、不读取模型 endpoint/key，也不创建第二层 SandboxBroker；普通命令子进程继承 Runtime 的 token/Job，扩展权限命令和 MCP 连接/操作经认证 IPC 交给 Broker；Git CLI 使用相同命令路径。
 *
 *    Skill 目录摘要由 Broker 提供，按需正文通过名称查询，不读取专用账户 home 或投影宿主技能根；MCP 仅接收公开服务用途摘要，不接收连接配置。
 * 1. start 接受 Broker 绑定任务的安全设置，恢复 session 上下文并在工作区生成指令和文件工具。
 * 2. SessionTokenCalibration 在首次检查前恢复 Broker 提供的实报锚点，响应保存后经 IPC 保存新锚点；ContextManager 在 Runtime 内计量/压缩，快照读写经 RuntimeSessionClient 回到 Broker。摘要容量另向 Broker 的 compaction provider 查询，不使用主任务的手动窗口。
 * 3. model-loop 共用轮次、有界重试和上下文超限恢复，model-response 共用响应接收顺序，dispatch-model-tool 共用节点分派，model-tool-batch 共用工具计划、结果截断与判定；每轮模型调用经 RuntimeModelProvider 代理；工具 DAG 先并行准备已就绪节点，取得有界 worker 槽后执行文件编辑、普通命令或已获批准的 Broker 命令。
 *    Runtime 普通命令按调用注入独立 tool_review 主模型代理，不设总运行时限；复查只返回等待/停止，usage 与决定经常规事件持久化。
 * 4. UI/session 事件按连接排队；无效 DAG 回传修正，实际取得执行槽的工具和 read_file 内部阶段带单调时间戳上报，由 Broker 统一组装并归档；工具结果增量保存，未知副作用不重放。
 * 5. 已选任务在 Runtime 内运行独立只读 Worker，按 Broker 下发能力向子模型追加内置搜索并继承任务输出设置及已知容量约束，子状态、问题回执、模型/租约及固定无正文的 trace 经任务绑定 IPC；收尾确认线程退出后再由 Broker 清理。
 *
 * Git 没有专属调度或隐式转发。越界命令先经 IPC 审批取得一次性授权，获得 worker 槽后由 Broker 启动，因而可与无依赖的普通工具正确并行。context/tool/model tracing 经固定 schema 回到 Broker。
 * 工具异步上下文安装固定进程 observer，取消/终止/直子退出经白名单 IPC 回传；持久化阶段携带 callId。
 */

import { SessionTokenCalibration } from "../context/session-token-calibration.js";
import type { TokenAnchor } from "../context/token-anchor.js";
import { createBudget } from "../context/token-budget.js";
import {
  ContextManager,
  type ContextTrace,
} from "../context/context-manager.js";
import {
  historyDefinition,
  readContextHistoryAsync,
} from "../context/history.js";
import { prepareTaskContext } from "../agent/context.js";
import { createInstructions } from "../agent/instructions.js";
import { SubagentCoordinator } from "../agent/subagent-coordinator.js";
import {
  subagentToolDefinition,
  type SubagentAction,
} from "../agent/subagent-contracts.js";
import { RuntimeSubagentClient } from "./runtime-subagent-client.js";
import { runtimeDefinitions, webSearchTool } from "../tools/registry.js";
import { createToolReviewer } from "../agent/tool-review.js";
import { executeToolGraph, type ToolGraphNode } from "../tools/tool-graph.js";
import { ToolRunner } from "../tools/tool-runner.js";
import type { ReadFileTraceStage } from "../tools/read-file-content.js";
import { RuntimeIpcError, type RuntimeIpcPeer } from "./runtime-ipc-peer.js";
import type {
  RuntimeIpcRequest,
  RuntimeTaskSettings,
} from "./runtime-ipc-protocol.js";
import type { RuntimeExecutionIdentity } from "./runtime-capability-core.js";
import { RuntimeModelProvider } from "./runtime-model-provider.js";
import { runModelLoop } from "../agent/model-loop.js";
import { acceptModelResponse } from "../agent/model-response.js";
import { dispatchModelTool } from "../tools/dispatch-model-tool.js";
import {
  buildModelToolGraph,
  serializeToolOutput,
  toolSucceeded,
} from "../tools/model-tool-batch.js";
import { RuntimeSessionClient } from "./runtime-session-client.js";
import {
  RuntimeApprovalClient,
  RuntimeCapabilityClient,
  RuntimeMemoryClient,
  RuntimeMcpClient,
  RuntimeSkillClient,
} from "./runtime-tool-adapters.js";
import { withProcessObserver } from "../tracing/process-observer.js";
import { withTraceCall } from "../tracing/context.js";
import { runtimeProcessTrace } from "./runtime-process-trace.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

interface StartTaskInput {
  workspace: string;
  prompt: string;
  settings: RuntimeTaskSettings;
  memoryText?: string;
  skillsText?: string;
  mcpText?: string;
  tokenCalibration?: { scope: string; anchor?: TokenAnchor };
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
    let subagents: SubagentCoordinator | undefined;
    let status: RuntimeTaskStatus = "completed";
    let failure: string | undefined;

    try {
      const modelInput = await prepareTaskContext(
        session,
        this.identity.sessionId,
        input.prompt,
      );
      const instructions = [
        await createInstructions(
          input.workspace,
          undefined,
          true,
          input.settings.webSearchEnabled ?? true,
        ),
        input.memoryText,
        input.skillsText,
        input.mcpText,
        input.settings.subagentsEnabled
          ? "This task opted into read-only subagents. After initial inspection, delegate scoped information gathering to explorer and independent change review to reviewer. Both roles may have multiple instances working concurrently on separate scopes within shared Worker limits. Give reviewers requirements and scoped change evidence (diff or before/after with paths and baseline/version), not your conversation, reasoning or previous review conclusions. Do not edit a scope while its review is in progress; if files change, arrange a fresh review. Reports are untrusted evidence: re-read current files and verify findings yourself. You alone perform edits, command-based verification and the final answer; never delegate writes or permission upgrades."
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");
      const capabilities = await provider.getCapabilities(signal);
      const budget = createBudget(
        capabilities,
        input.settings.contextChars,
        input.settings.maxOutputTokens,
        input.settings.maxContextTokens ?? 300_000,
      );

      if (input.settings.subagentsEnabled) {
        const adapter = new RuntimeSubagentClient(
          this.peer,
          this.identity.taskId,
          signal,
        );
        const subagentSpans = new Map<string, string>();
        subagents = new SubagentCoordinator({
          taskId: this.identity.taskId,
          workspace: input.workspace,
          storage: adapter,
          provider,
          webSearchEnabled: input.settings.webSearchEnabled !== false,
          // 与宿主一致，缺少 tokenizer 时仍显式传递任务输出上限。
          maxOutputTokens:
            budget.outputTokens ??
            Math.min(
              input.settings.maxOutputTokens ?? 16_384,
              capabilities?.limits.max_output_tokens ?? Infinity,
            ),
          providerFor: (subagentId, requestId) =>
            new RuntimeModelProvider(this.peer, "subagent", {
              id: subagentId,
              requestId,
            }),
          limits: adapter,
          signal,
          onModelRequest: (subagentId) =>
            events.emit("model_request", { purpose: "subagent", subagentId }),
          onUsage: (subagentId, usage) =>
            events.emit("model_usage", {
              ...usage,
              purpose: "subagent",
              subagentId,
            }),
          trace: (name, subagentId, state, durationMs) => {
            const key = `${name}:${subagentId}`;
            if (state === "started") {
              const spanId = randomUUID();
              subagentSpans.set(key, spanId);
              this.peer.event({
                type: "event",
                event: "trace_span_start",
                spanId,
                timestampUs: runtimeTraceNowUs(),
                name: name as
                  | "subagent.worker"
                  | "subagent.model"
                  | "subagent.tool.read"
                  | "subagent.message"
                  | "subagent.cancel"
                  | "subagent.question",
                attributes: { subagentId },
              });
            } else {
              const spanId = subagentSpans.get(key);
              if (spanId) {
                this.peer.event({
                  type: "event",
                  event: "trace_span_end",
                  spanId,
                  timestampUs: runtimeTraceNowUs(),
                  status:
                    state === "ok" || state === "completed"
                      ? "ok"
                      : state === "cancelled"
                        ? "cancelled"
                        : "error",
                  attributes: { subagentId, durationMs },
                });
                subagentSpans.delete(key);
              }
            }
          },
        });
      }

      events.emit("context_budget", {
        model: input.settings.model,
        unit: budget.unit,
        inputLimit: budget.limit,
        contextWindowTokens: capabilities?.limits.max_context_window_tokens,
        effectiveWindowTokens: budget.contextWindowTokens,
        modelMaxOutputTokens: capabilities?.limits.max_output_tokens,
        outputTokens: budget.outputTokens,
        safetyTokens: budget.safetyTokens,
        tokenizer: budget.tokenizer,
      });
      const toolSettings = runtimeToolSettings(input.settings);
      const capability = new RuntimeCapabilityClient(this.peer);
      const mcp = new RuntimeMcpClient(this.peer);
      const skills = new RuntimeSkillClient(this.peer);
      const runner = new ToolRunner({
        root: input.workspace,
        sessionId: this.identity.sessionId,
        taskId: this.identity.taskId,
        signal,
        settings: toolSettings,
        reviewTool: createToolReviewer({
          provider: (subject) =>
            new RuntimeModelProvider(
              this.peer,
              "tool_review",
              undefined,
              subject.callId,
            ),
          prompt: input.prompt,
          emit: (type, data) => events.emit(type, data),
        }),
        approvals: new RuntimeApprovalClient(this.peer),
        memory: new RuntimeMemoryClient(this.peer, signal),
        skillExecute: (request, requestSignal, toolCallId) => {
          if (!toolCallId) {
            throw new Error("Skill 请求缺少工具调用标识。");
          }

          return skills.execute(request, toolCallId, requestSignal);
        },
        prepareMcp: (request, requestSignal, toolCallId) => {
          if (!toolCallId) {
            throw new Error("MCP 请求缺少工具调用标识。");
          }

          return mcp.prepare(request, toolCallId, requestSignal);
        },
        prepareRunWithPermissions: (request, requestSignal, toolCallId) => {
          if (!toolCallId) {
            throw new Error("扩展权限请求缺少工具调用标识。");
          }

          return capability.prepare(request, toolCallId, requestSignal);
        },
        executionBoundary: "agent-runtime",
        parentExecutionInstanceId: this.identity.executionInstanceId,
        emit: (type, data) => events.emit(type, data),
      });
      // 只声明 Broker 确认可用的原生搜索；新协议不能误收到 Responses 内置工具。
      const tools = [
        ...runtimeDefinitions,
        ...(input.settings.webSearchEnabled !== false ? [webSearchTool] : []),
        historyDefinition,
        ...(input.settings.subagentsEnabled ? [subagentToolDefinition] : []),
      ];
      const calibration = new SessionTokenCalibration({
        budget,
        scope: input.tokenCalibration?.scope ?? "0".repeat(64),
        read: async () => input.tokenCalibration?.anchor,
        write: async (anchor) => {
          if (input.tokenCalibration) {
            await session.saveTokenAnchor(anchor);
          }
        },
        trace,
        signal,
      });
      await calibration.restore(modelInput, instructions, tools);
      const context = new ContextManager({
        store: session,
        sessionId: this.identity.sessionId,
        model: input.settings.model,
        limit: budget.limit,
        currentFileHash: (file) => runner.currentFileHash(file),
        measure: budget.measure,
        resetMeasurement: budget.resetMeasurement,
        measurement: budget.measurement,
        unit: budget.unit,
        maxOutputTokens: budget.outputTokens,
        provider: compactionProvider,
        summaryBudget: async () => {
          const metadata = await compactionProvider
            .getCapabilities(signal)
            .catch(() => {
              // Broker 已记录能力查询失败；取消不得退化为字符模式继续发送请求。
              signal.throwIfAborted();
              events.emit("notice", {
                text: "摘要模型容量查询失败，使用备用字符预算。",
              });

              return undefined;
            });
          signal.throwIfAborted();

          return createBudget(
            metadata,
            input.settings.contextChars,
            input.settings.maxOutputTokens,
          );
        },
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
      let step = 0;
      let attempt = 0;
      let requestInput = currentInput;

      this.peer.event({
        type: "event",
        event: "runtime_state",
        state: "running",
      });
      const outcome = await runModelLoop({
        maxSteps: input.settings.maxSteps,
        signal,
        prepareStep: async (currentStep) => {
          step = currentStep;
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

          requestInput = currentInput;
        },
        request: async (currentAttempt) => {
          attempt = currentAttempt;
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
        onRetry: (error, failedAttempt, delayMs) =>
          events.emit("notice", {
            text: `${error.message} ${delayMs} ms 后重试（${failedAttempt}/2）。`,
            code: error.code,
            step,
            attempt,
          }),
        prepareOverflow: async () => {
          currentInput = await context.prepare(
            currentInput,
            instructions,
            tools,
            true,
          );
        },
        acceptResponse: async (response) => {
          await acceptModelResponse(response, {
            input: currentInput,
            requestInput,
            instructions,
            tools,
            calibration,
            recordUsage: (usage) =>
              events.emit("model_usage", {
                ...usage,
                purpose: "task",
                step,
                attempt,
              }),
            appendContext: (output) =>
              session.appendContext(this.identity.sessionId, output),
            emitAssistant: (text) =>
              events.emit("assistant", { text, step, attempt }),
          });
        },
        complete: () => events.flush(),
        executeTools: async (calls) => {
          const batchId = randomUUID();
          let graph;
          try {
            graph = buildModelToolGraph(calls, {
              subagentsEnabled: input.settings.subagentsEnabled ?? false,
            });
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message.slice(0, 2_000)
                : "未知错误";

            const feedback: unknown[] = [];
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
              const item = {
                type: "function_call_output",
                call_id: call.call_id,
                output: JSON.stringify(result),
              };
              currentInput.push(item);
              feedback.push(item);
              events.emit("tool_result", {
                name: call.name,
                callId: call.call_id,
                batchId,
                nodeId: `invalid-${ordinal + 1}`,
                result,
              });
            }

            await session.appendContext(this.identity.sessionId, feedback);
            await events.flush();

            return "invalid";
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
            currentInput,
            input.settings.outputChars,
            events,
            batchId,
            trace,
          );
          await executeToolGraph(graph, {
            execute: async (node, acquireExecutionSlot) =>
              withTraceCall(node.callId, () =>
                withProcessObserver(
                  () => runtimeProcessTrace(this.peer, node.callId),
                  async () => {
                    signal.throwIfAborted();
                    events.emit("tool_start", {
                      name: node.name,
                      callId: node.callId,
                      batchId,
                      nodeId: node.nodeId,
                      dependsOn: node.dependsOn,
                      args: node.arguments,
                    });
                    // 参数先在 Broker 登记；后续固定 trace IPC 只携带调用 ID、槽号与安全数值。
                    await events.flush();

                    let result: unknown;
                    let executionSpan: string | undefined;
                    const startExecution = async () => {
                      const slot = await acquireExecutionSlot();
                      executionSpan = trace.startToolExecution(
                        node.callId,
                        slot,
                      );
                    };

                    const readFileSpans = new Map<ReadFileTraceStage, string>();
                    try {
                      result = await dispatchModelTool(node, {
                        subagentsEnabled:
                          input.settings.subagentsEnabled ?? false,
                        subagents,
                        runner,
                        startExecution,
                        // await 等待后仅取得槽，不把等待事后记录为工具执行耗时。
                        afterSubagentWait: acquireExecutionSlot,
                        readHistory: (arguments_) =>
                          readContextHistoryAsync(
                            session,
                            this.identity.sessionId,
                            arguments_,
                            input.settings.outputChars,
                          ),
                        traceReadFile: (stage, state, details) => {
                          if (state === "started") {
                            readFileSpans.set(
                              stage,
                              trace.startToolStage(stage, node.callId),
                            );
                          } else {
                            const handle = readFileSpans.get(stage);
                            if (handle) {
                              trace.endToolStage(handle, state, details);
                              readFileSpans.delete(stage);
                            }
                          }
                        },
                      });
                    } catch (error) {
                      signal.throwIfAborted();
                      result = {
                        error:
                          error instanceof Error
                            ? error.message.slice(0, 2_000)
                            : "工具执行失败。",
                      };
                    } finally {
                      if (executionSpan) {
                        trace.endToolStage(
                          executionSpan,
                          signal.aborted
                            ? "cancelled"
                            : toolSucceeded(result)
                              ? "ok"
                              : "error",
                        );
                      }
                    }

                    await persistence.save(node, result);

                    return toolSucceeded(result);
                  },
                ),
              ),
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

          return "executed";
        },
      });
      // 保留 Runtime 既有终态：最后一轮无效图反馈后自然结束，只有实际工具批次耗尽轮次才报错。
      if (outcome === "step-limit") {
        throw new Error("已达到最大模型调用次数，任务停止。");
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

    try {
      await subagents?.close();
    } catch {
      status = "failed";
      failure = "subagent 清理或状态落盘失败，不能确认主任务完成。";
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

function runtimeTraceNowUs() {
  return Math.round((performance.timeOrigin + performance.now()) * 1_000);
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
    maxContextTokens: settings.maxContextTokens ?? 300_000,
    contextChars: settings.contextChars,
    outputChars: settings.outputChars,
    logLevel: "info",
  };
}

/** Runtime 只上报固定 context/tool/read_file/结果持久化阶段和有界元数据；并发工具阶段不借用 context 的全局父栈。 */
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
      timestampUs: runtimeTraceNowUs(),
      name: name as
        | "context.usage.restore"
        | "context.usage.save"
        | "context.prepare"
        | "context.prepare.measure_request_view"
        | "context.request"
        | "context.request.measure_input"
        | "tool.result_persist",
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
      timestampUs: runtimeTraceNowUs(),
      status,
      attributes,
    });
  }

  currentSpanId() {
    return this.stack.at(-1);
  }

  /** 槽号由调度器分配；参数只留在 Broker 已收到的 tool_start 事件。 */
  startToolExecution(callId: string, slot: number) {
    const spanId = randomUUID();
    this.peer.event({
      type: "event",
      event: "trace_span_start",
      spanId,
      timestampUs: runtimeTraceNowUs(),
      name: "tool.execute",
      attributes: { callId, slot },
    });

    return spanId;
  }

  startToolStage(name: ReadFileTraceStage, callId: string) {
    const spanId = randomUUID();
    this.peer.event({
      type: "event",
      event: "trace_span_start",
      spanId,
      timestampUs: runtimeTraceNowUs(),
      name,
      attributes: { callId },
    });

    return spanId;
  }

  endToolStage(
    spanId: string,
    status: "cancelled" | "error" | "ok",
    details?: { bytes?: number; computeMs?: number },
  ) {
    this.peer.event({
      type: "event",
      event: "trace_span_end",
      spanId,
      timestampUs: runtimeTraceNowUs(),
      status,
      attributes: details ?? {},
    });
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
    private input: any[],
    private outputChars: number,
    private events: OrderedRuntimeEvents,
    private batchId: string,
    private trace: RuntimeContextTrace,
  ) {}

  save(node: ToolGraphNode, result: unknown) {
    this.pending = this.pending.then(async () => {
      const { output } = serializeToolOutput(result, this.outputChars);

      const event = {
        name: node.name,
        callId: node.callId,
        batchId: this.batchId,
        nodeId: node.nodeId,
        result,
      };
      this.input.push({
        type: "function_call_output",
        call_id: node.callId,
        output,
      });
      const action =
        node.name === "subagent"
          ? (node.arguments as { request?: SubagentAction }).request
          : undefined;
      if (
        action?.action === "collect" &&
        output === JSON.stringify(result) &&
        result !== null &&
        typeof result === "object" &&
        "reports" in result
      ) {
        await this.session.commitSubagentCollect(
          action.subagentIds,
          this.input,
          {
            ...event,
            name: "subagent",
          },
        );
      } else {
        const span = this.trace.start("tool.result_persist", {
          inputItems: 1,
          callId: node.callId,
        });
        try {
          await this.events.flush();
          await this.session.commitToolResult(event, this.input.at(-1));
          this.trace.end(span, "ok");
        } catch (error) {
          this.trace.end(span, "error", {
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          throw error;
        }
      }
    });

    return this.pending;
  }

  flush() {
    return this.pending;
  }
}
