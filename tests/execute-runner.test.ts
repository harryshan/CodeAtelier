/**
 * 使用可控 Broker 验证独立 Runner 的共同生命周期，不启动原生进程或申请真实权限。
 *
 * 1. fixture 收集执行实例、阶段事件和命令，保持每次调用独立的身份与取消信号。
 * 2. 两种 Runner 都覆盖成功、非零退出、启动前失败、启动后失败、取消及 unknown 优先级，断言状态与副作用记录。
 * 3. 强制调用宿主 fallback 与命令构造失败用例验证拒绝宿主执行、保留失败记录且不重试。
 */

import { expect, it } from "vitest";
import { executeSandboxRunner } from "../src/sandbox/execute-runner.js";
import type {
  SandboxCommand,
  SandboxStatus,
  ExecutionInstanceRecord,
} from "../src/sandbox/types.js";

type RunnerBroker = Parameters<typeof executeSandboxRunner>[0];

function fixture(kind: "push-runner" | "capability-runner") {
  const controller = new AbortController();
  const records: ExecutionInstanceRecord[] = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const commands: SandboxCommand[] = [];
  const status: SandboxStatus = {
    enabled: true,
    requested: true,
    applied: true,
    mode: "sandboxed",
    platform: "win32",
    level: "test",
  };
  const broker: RunnerBroker = {
    statusFor: () => status,
    recordExecutionInstance(record) {
      records.push(record);
    },
    async executeCommand(command, _host, onStage, options) {
      expect(options).toEqual({ allowHostFallback: false });
      commands.push(command);
      onStage("executing", status);
      command.onProcessStarted(53, "runtime", "1234");

      return {
        result: { output: "result", exitCode: 0, truncated: false },
        status,
      };
    },
  };
  const execution: Parameters<typeof executeSandboxRunner>[1] = {
    taskId: "task",
    toolCallId: "call",
    kind,
    signal: controller.signal,
    fallbackError: "no host fallback",
    command: () => ({
      sessionId: "session",
      command: "test",
      args: ["arg"],
      cwd: "workspace",
      timeoutMs: 1000,
      outputLimit: 2000,
      onOutput() {},
    }),
    emit(type, data) {
      events.push({ type, data });
    },
  };

  return { broker, execution, controller, records, events, commands, status };
}

for (const kind of ["push-runner", "capability-runner"] as const) {
  it(`${kind} preserves identity, process metadata, stages and the original result`, async () => {
    const { broker, execution, records, events, commands } = fixture(kind);
    const outcome = await executeSandboxRunner(broker, execution);

    expect(outcome.result).toEqual({
      output: "result",
      exitCode: 0,
      truncated: false,
    });
    expect(records.map((record) => record.state)).toEqual([
      "created",
      "running",
      "completed",
    ]);
    expect(records[1]).toMatchObject({
      pid: 53,
      pidKind: "runtime",
      processCreationTime100ns: "1234",
    });
    expect(records[2].sideEffectsPossible).toBe(false);
    expect(
      new Set(records.map((record) => record.executionInstanceId)),
    ).toEqual(new Set([outcome.executionInstanceId]));
    expect(
      records.every(
        (record) =>
          record.kind === kind &&
          record.toolCallId === "call" &&
          record.sandboxApplied,
      ),
    ).toBe(true);
    expect(
      events
        .filter((event) => event.type === "execution_instance")
        .map((event) => event.data),
    ).toEqual(records);
    expect(events).toContainEqual({
      type: "sandbox_stage",
      data: expect.objectContaining({
        stage: "executing",
        executionInstanceId: outcome.executionInstanceId,
      }),
    });
    expect(commands[0]).toMatchObject({
      taskId: "task",
      toolCallId: "call",
      kind,
      signal: execution.signal,
      executionInstanceId: outcome.executionInstanceId,
      args: ["arg"],
    });
  });

  it.each([
    {
      started: false,
      cancelled: false,
      unknown: false,
      state: "failed",
      effects: false,
    },
    {
      started: true,
      cancelled: false,
      unknown: false,
      state: "failed",
      effects: true,
    },
    {
      started: true,
      cancelled: true,
      unknown: false,
      state: "cancelled",
      effects: true,
    },
    {
      started: false,
      cancelled: true,
      unknown: false,
      state: "cancelled",
      effects: false,
    },
    {
      started: false,
      cancelled: true,
      unknown: true,
      state: "unknown",
      effects: true,
    },
  ])(`${kind} records failure boundary %j`, async (scenario) => {
    const { broker, execution, controller, records, status } = fixture(kind);
    const failure = new Error("execution failed");
    broker.executeCommand = async (command) => {
      if (scenario.started) {
        command.onProcessStarted(53, "runtime");
      }

      if (scenario.cancelled) {
        controller.abort(failure);
      }

      if (scenario.unknown) {
        status.mode = "unknown";
        status.failureCategory = "runtime_execution";
      }

      throw failure;
    };

    await expect(executeSandboxRunner(broker, execution)).rejects.toBe(failure);
    expect(records.map((record) => record.state)).toEqual(
      scenario.started
        ? ["created", "running", scenario.state]
        : ["created", scenario.state],
    );
    expect(records.at(-1)).toMatchObject({
      state: scenario.state,
      sideEffectsPossible: scenario.effects,
      mode: scenario.unknown ? "unknown" : "windows-sandbox-user",
    });
  });

  it(`${kind} returns nonzero process output with failed and possible-side-effect state`, async () => {
    const { broker, execution, records, status } = fixture(kind);
    broker.executeCommand = async (command) => {
      command.onProcessStarted(53, "runtime");

      return {
        result: { output: "partial output", exitCode: 2, truncated: true },
        status,
      };
    };

    const outcome = await executeSandboxRunner(broker, execution);
    expect(outcome.result).toEqual({
      output: "partial output",
      exitCode: 2,
      truncated: true,
    });
    expect(records.at(-1)).toMatchObject({
      state: "failed",
      sideEffectsPossible: true,
    });
  });

  it(`${kind} rejects any host fallback`, async () => {
    const { broker, execution, records, status } = fixture(kind);
    broker.executeCommand = async (_command, host) => ({
      result: await host(),
      status,
    });

    await expect(executeSandboxRunner(broker, execution)).rejects.toThrow(
      "no host fallback",
    );
    expect(records.at(-1)).toMatchObject({
      state: "failed",
      sideEffectsPossible: false,
    });
  });

  it(`${kind} records command construction failure before any process starts`, async () => {
    const { broker, execution, records, commands } = fixture(kind);
    execution.command = () => {
      throw new Error("executable missing");
    };

    await expect(executeSandboxRunner(broker, execution)).rejects.toThrow(
      "executable missing",
    );
    expect(commands).toEqual([]);
    expect(records.map((record) => record.state)).toEqual([
      "created",
      "failed",
    ]);
    expect(records.at(-1)?.sideEffectsPossible).toBe(false);
  });
}
