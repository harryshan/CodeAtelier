/**
 * 在既有专用 Runtime 中执行候选命令计划，供 Engine 的 Local 发布收尾调用。
 * 1. 使用原任务身份、新 execution instance 和候选 workspace 启动；不附加来源/Git 根，不处理宿主 fallback。
 * 2. 固定 CandidateCommandPlan 经现有 IPC/ToolRunner 顺序执行；临时上下文不读写主会话模型历史。
 * 3. handlers 保存候选事件与可信进程事实，拒绝扩展权限、MCP、Skill、记忆写入和额外模型用途。
 * 4. 取消先发 IPC cancel，等待停止回执和平台 clean；丢失终态、孤儿或清理失败按 unknown 保留现场。
 * 5. trace 关联原任务与新实例，仅含阶段/时长/状态；命令和输出只走脱敏历史回调，不进入 trace。
 * 不更改 Runtime 协议或安装态；调用者提供已绑定的生产 launcher，测试 transport 不能作为 Sandbox 证明。
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  AgentRuntimeFallbackError,
  type AgentRuntimeLauncher,
  type LaunchedAgentRuntime,
} from "../sandbox/agent-runtime-launcher.js";
import {
  RuntimeBrokerGateway,
  type RuntimeExecutionIdentity,
} from "../sandbox/runtime-capability-core.js";
import {
  RuntimeIpcBrokerSession,
  type RuntimeIpcBrokerHandlers,
} from "../sandbox/runtime-ipc-broker-session.js";
import type { TraceRecorder } from "../tracing/recorder.js";
import type { TraceSpan } from "../tracing/types.js";
import { CandidateCleanupUnknownError } from "./candidate-reads.js";
import { CandidateCommandPlan, validationCommands } from "./command-plan.js";

export async function runCandidateCommands(input: {
  launcher: AgentRuntimeLauncher;
  traces: TraceRecorder;
  log: Logger;
  sessionId: string;
  taskId: string;
  workspace: string;
  commands: readonly string[];
  signal: AbortSignal;
  getErrorSecrets?: () => string[];
  emit(type: string, data: unknown): Promise<void>;
}) {
  const commands = validationCommands(input.commands);
  const plan = new CandidateCommandPlan(commands);
  input.signal.throwIfAborted();
  const identity: RuntimeExecutionIdentity = {
    sessionId: input.sessionId,
    taskId: input.taskId,
    executionInstanceId: randomUUID(),
    kind: "agent-runtime",
  };
  const nonce = randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  const span = input.traces.startSpan(input.taskId, {
    name: "local_overlay.validation_runtime",
    category: "sandbox",
    track: "Candidate Runtime",
    attributes: {
      executionInstanceId: identity.executionInstanceId,
      commands: commands.length,
    },
  });
  const runtimeSpans = new Map<string, TraceSpan | undefined>();
  const completion = new AbortController();
  let launched: LaunchedAgentRuntime | undefined;
  let broker: RuntimeIpcBrokerSession | undefined;
  let authorized = true;
  let started = false;
  let cleaned = false;
  let closeAttempted = false;
  let outcome: "ok" | "error" | "cancelled" | "unknown" = "unknown";
  let deadline: NodeJS.Timeout | undefined;
  let context: unknown[] = [];
  const state: { reported?: { status: string; failure?: string } } = {};
  const emit = (type: string, data: unknown) =>
    input.emit("local_validation", {
      executionInstanceId: identity.executionInstanceId,
      event: type,
      data,
    });
  const execution = (status: string) =>
    input.emit("execution_instance", {
      executionInstanceId: identity.executionInstanceId,
      kind: "agent-runtime",
      purpose: "local-validation",
      mode: launched?.mode ?? "unknown",
      state: status,
      sideEffectsPossible:
        status === "unknown" || (started && status === "cancelled"),
      createdAt,
      updatedAt: new Date().toISOString(),
      sandboxRequested: true,
      sandboxApplied:
        !!launched &&
        ["windows-sandbox-user", "linux-bubblewrap", "macos-seatbelt"].includes(
          launched.mode ?? "",
        ),
      ...(launched
        ? {
            pid: launched.pid,
            pidKind: launched.pidKind ?? "runtime",
            processCreationTime100ns: launched.processCreationTime100ns,
          }
        : {}),
    });
  const deny = async (): Promise<never> => {
    throw new Error("候选验证不开放此 Broker 能力。");
  };

  const cancel = () => {
    broker?.cancel("候选验证已取消。");
    deadline ??= setTimeout(
      () => completion.abort(new Error("候选 Runtime 停止未确认。")),
      10_000,
    );
  };

  try {
    await execution("created");
    try {
      launched = await input.launcher.launch({
        identity,
        nonce,
        workspace: input.workspace,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof AgentRuntimeFallbackError) {
        outcome = "error";
        await execution("failed");

        return { drained: true, sandboxApplied: false, exitCode: null };
      }

      throw error;
    }

    if (
      !["windows-sandbox-user", "linux-bubblewrap", "macos-seatbelt"].includes(
        launched.mode ?? "",
      )
    ) {
      throw new Error("候选 Runtime 未证明 Sandbox 执行模式。");
    }

    await execution("running");
    const gateway = new RuntimeBrokerGateway(
      {
        executionMode: launched.mode,
        getErrorSecrets: input.getErrorSecrets,
        authorize: (candidate) => authorized && candidate === identity,
        approveCommand: async () => ({ approved: false }),
        modelProvider: (_identity, purpose) => {
          if (purpose !== "task") {
            throw new Error("候选验证只接受固定命令计划。");
          }

          return { model: "local-validation-plan", provider: plan };
        },
      },
      input.traces,
      input.log,
    );
    const handlers: RuntimeIpcBrokerHandlers = {
      traces: input.traces,
      getErrorSecrets: input.getErrorSecrets,
      requestApproval: async () => ({ approved: false }),
      prepareCapabilityCommand: deny,
      applyMemory: deny,
      appendSessionEvent: async (_identity, type, data) => {
        await emit(type, data);
      },
      readContext: async () => context,
      saveContext: async (_identity, items) => {
        context = items;
      },
      appendContext: async (_identity, items) => {
        context.push(...items);
      },
      saveTokenAnchor: async () => {},
      readEvents: async () => [],
      latestContextSnapshot: async () => undefined,
      readContextSnapshot: deny,
      compactContext: deny,
      commitToolResult: async (_identity, body) => {
        plan.commit(body);
        await emit("tool_result", body.event);
        context.push(body.feedback);
      },
      runtimeCompleted: async (_identity, result) => {
        state.reported = result;
      },
      traceSpan: (event) => {
        if (!input.traces.acceptExternalTime(input.taskId, event.timestampUs)) {
          throw new Error("候选 Runtime trace 时间戳无效。");
        }

        if (event.event === "trace_span_start") {
          if (runtimeSpans.has(event.spanId)) {
            throw new Error("候选 Runtime trace 标识重复。");
          }

          runtimeSpans.set(
            event.spanId,
            input.traces.startSpan(input.taskId, {
              name: `validation.${event.name}`,
              category: "sandbox",
              track: "Candidate Runtime tools",
              parentSpanId: span?.id,
              processId: launched?.pid,
              startedAtUs: event.timestampUs,
              attributes: {
                executionInstanceId: identity.executionInstanceId,
                ...event.attributes,
              },
            }),
          );
        } else {
          if (!runtimeSpans.has(event.spanId)) {
            throw new Error("候选 Runtime trace 终态缺少开始事件。");
          }

          input.traces.endSpan(
            runtimeSpans.get(event.spanId),
            event.status,
            event.attributes,
            event.timestampUs,
          );
          runtimeSpans.delete(event.spanId);
        }
      },
    };
    broker = new RuntimeIpcBrokerSession(
      launched,
      identity,
      nonce,
      gateway,
      handlers,
    );
    input.signal.addEventListener("abort", cancel, { once: true });
    input.signal.throwIfAborted();
    started = true;
    const task = broker.startTask(
      {
        workspace: input.workspace,
        prompt: "Run the fixed candidate validation commands.",
        settings: {
          model: "local-validation-plan",
          webSearchEnabled: false,
          subagentsEnabled: false,
          maxSteps: commands.length + 1,
          commandTimeoutMs: 0,
          maxContextTokens: 300_000,
          maxOutputTokens: 1_024,
          contextChars: 1_000_000,
          outputChars: 8_000,
        },
      },
      completion.signal,
    );
    // start_task can be cancelled without a response. A stopping event plus the
    // authenticated terminal report remains required before platform cleanup.
    const stopped = broker.waitForStop(completion.signal).then(() => {
      if (!state.reported) {
        throw new Error("候选 Runtime 停止前缺少终态。");
      }

      return state.reported;
    });
    await Promise.race([task, stopped]);
    await stopped;
    const status = state.reported!.status;
    closeAttempted = true;
    cleaned =
      (await launched.close(
        input.signal.aborted
          ? "cancel"
          : status === "completed"
            ? "completed"
            : "failed",
      )) === "clean";
    if (!cleaned) {
      throw new CandidateCleanupUnknownError();
    }

    authorized = false;
    outcome = input.signal.aborted
      ? "cancelled"
      : status === "completed" && plan.exitCode === 0
        ? "ok"
        : "error";
    await execution(
      outcome === "ok"
        ? "completed"
        : outcome === "cancelled"
          ? "cancelled"
          : "failed",
    );

    return {
      drained: true,
      sandboxApplied: true,
      exitCode:
        outcome === "ok" ? 0 : plan.exitCode === 0 ? null : plan.exitCode,
    };
  } catch (error) {
    if (launched && !closeAttempted) {
      closeAttempted = true;
      const reason = !started && input.signal.aborted ? "cancel" : "unknown";
      cleaned =
        (await launched.close(reason).catch(() => "orphaned" as const)) ===
        "clean";
      if (reason === "cancel" && cleaned) {
        outcome = "cancelled";
        await execution("cancelled");

        return { drained: true, sandboxApplied: true, exitCode: null };
      }
    }

    outcome = "unknown";
    await execution("unknown").catch(() => {});
    throw new CandidateCleanupUnknownError(error);
  } finally {
    authorized = false;
    input.signal.removeEventListener("abort", cancel);
    clearTimeout(deadline);
    completion.abort(new Error("候选 Runtime 生命周期结束。"));
    if (cleaned) {
      broker?.releaseSubagentLeases();
    }

    for (const pending of runtimeSpans.values()) {
      input.traces.endSpan(pending, "unknown", { incomplete: true });
    }

    input.traces.endSpan(span, outcome);
  }
}
