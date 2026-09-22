/**
 * Engine 在完成专属审批后，用此入口执行独立 Push Runner 或 Capability Runner。
 * 本模块共用执行实例的状态记录与失败处理，不负责审批、权限根构造或命令参数选择。
 *
 * 1. RunnerExecution 接收任务身份、取消信号、拒绝 fallback 的说明，以及审批后构造命令的函数。
 * 2. executeSandboxRunner 创建实例并先发布 created，再在 try 内构造命令和调用 Broker；onProcessStarted 发布 running。
 * 3. 成功返回实例 ID 和进程结果；非零退出、取消、启动后失败与 unknown 保留现有副作用标记，不重放命令。
 *
 * execution_instance 与 sandbox_stage 沿用 Engine 的事件入口，Broker 继续承担执行 tracing 和 generation 账本。
 * 此入口固定禁止宿主 fallback，不向 Agent Runtime 传递扩展权限或凭据。
 */

import { randomUUID } from "node:crypto";
import type { SandboxBroker } from "./broker.js";
import type {
  ExecutionInstanceRecord,
  ExecutionInstanceState,
  SandboxCommand,
} from "./types.js";

interface RunnerExecution {
  taskId: string;
  toolCallId: string;
  kind: "push-runner" | "capability-runner";
  signal: AbortSignal;
  fallbackError: string;
  command(): Omit<
    SandboxCommand,
    | "taskId"
    | "toolCallId"
    | "kind"
    | "signal"
    | "executionInstanceId"
    | "onProcessStarted"
  >;
  emit(type: string, data: unknown): void;
}

export async function executeSandboxRunner(
  broker: Pick<
    SandboxBroker,
    "statusFor" | "recordExecutionInstance" | "executeCommand"
  >,
  execution: RunnerExecution,
) {
  const executionInstanceId = randomUUID();
  const createdAt = new Date().toISOString();
  let started = false;
  const publish = (
    state: ExecutionInstanceState,
    extra: Partial<ExecutionInstanceRecord> = {},
  ) => {
    const status = broker.statusFor(execution.taskId, executionInstanceId);
    const record: ExecutionInstanceRecord = {
      executionInstanceId,
      toolCallId: execution.toolCallId,
      kind: execution.kind,
      mode:
        status.mode === "sandboxed"
          ? "windows-sandbox-user"
          : status.mode === "unknown"
            ? "unknown"
            : "host-process",
      state,
      createdAt,
      updatedAt: new Date().toISOString(),
      sandboxRequested: true,
      sandboxApplied: status.mode === "sandboxed",
      failureCategory: status.failureCategory,
      ...extra,
    };
    execution.emit("execution_instance", record);
    broker.recordExecutionInstance(record);
  };

  publish("created");
  try {
    const outcome = await broker.executeCommand(
      {
        ...execution.command(),
        taskId: execution.taskId,
        toolCallId: execution.toolCallId,
        kind: execution.kind,
        signal: execution.signal,
        executionInstanceId,
        onProcessStarted: (pid, pidKind, processCreationTime100ns) => {
          started = true;
          publish("running", { pid, pidKind, processCreationTime100ns });
        },
      },
      async () => {
        throw new Error(execution.fallbackError);
      },
      (stage, status) =>
        execution.emit("sandbox_stage", {
          stage,
          executionInstanceId,
          ...status,
        }),
      { allowHostFallback: false },
    );
    publish(outcome.result.exitCode === 0 ? "completed" : "failed", {
      sideEffectsPossible: outcome.result.exitCode !== 0,
    });

    return { executionInstanceId, result: outcome.result };
  } catch (error) {
    const status = broker.statusFor(execution.taskId, executionInstanceId);
    publish(
      status.mode === "unknown"
        ? "unknown"
        : execution.signal.aborted
          ? "cancelled"
          : "failed",
      {
        sideEffectsPossible: started || status.mode === "unknown",
      },
    );
    throw error;
  }
}
