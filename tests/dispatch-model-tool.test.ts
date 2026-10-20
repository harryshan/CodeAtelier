/**
 * 验证共享单节点分派保持两种运行环境的执行槽与调用边界；不运行真实工具或线程。
 *
 * 1. fixture 以可观察阶段日志模拟审批、槽位、subagent、历史读取和 read_file trace，保留原参数与结果身份。
 * 2. 普通工具和历史读取覆盖正确分流；subagent 覆盖开关、缺失操作、等待前后槽位及宿主/Runtime 的计时差异。
 * 3. 可控 Promise 证明 await 未完成时不占槽；失败原样传播且不重试，不在共享层吞掉取消或未知执行结果。
 */

import { expect, it } from "vitest";
import { dispatchModelTool } from "../src/tools/dispatch-model-tool.js";
import type { ToolGraphNode } from "../src/tools/tool-graph.js";
import type { SubagentAction } from "../src/agent/subagent-contracts.js";

type Operations = Parameters<typeof dispatchModelTool>[1];

function node(name: string, arguments_: unknown = {}): ToolGraphNode {
  return {
    name,
    arguments: arguments_,
    nodeId: "node",
    callId: "call",
    dependsOn: [],
    ordinal: 0,
  };
}

function fixture() {
  const sequence: string[] = [];
  const result = { content: "result" };
  const operations: Operations = {
    subagentsEnabled: true,
    subagents: {
      async execute() {
        sequence.push("subagent");

        return result;
      },
    },
    runner: {
      forCall(callId) {
        expect(callId).toBe("call");

        return {
          async execute(name, arguments_, start, trace) {
            sequence.push("approval");
            expect(sequence).toEqual(["approval"]);
            expect(arguments_).toEqual({ path: "sample" });
            await start?.();
            sequence.push(name);
            trace?.("read_file.stat", "started");

            return result;
          },
        };
      },
    },
    async startExecution() {
      sequence.push("execution");
    },
    async afterSubagentWait() {
      sequence.push("slot-only");
    },
    async readHistory(arguments_) {
      expect(arguments_).toEqual({ snapshotId: "snapshot" });
      sequence.push("history");

      return result;
    },
    traceReadFile() {
      sequence.push("trace");
    },
  };

  return { operations, sequence, result };
}

it.each(["read_file", "run_command"])(
  "leaves %s approval and execution start to the runner",
  async (name) => {
    const state = fixture();
    const result = await dispatchModelTool(
      node(name, { path: "sample" }),
      state.operations,
    );

    expect(result).toBe(state.result);
    expect(state.sequence).toEqual(
      name === "read_file"
        ? ["approval", "execution", name, "trace"]
        : ["approval", "execution", name],
    );
  },
);

it("acquires execution before reading history without entering the runner", async () => {
  const state = fixture();
  const result = await dispatchModelTool(
    node("read_context_history", { snapshotId: "snapshot" }),
    state.operations,
  );

  expect(result).toBe(state.result);
  expect(state.sequence).toEqual(["execution", "history"]);
});

it.each(["disabled", "missing-coordinator", "missing-action"])(
  "rejects subagent %s before any execution",
  async (reason) => {
    const state = fixture();
    if (reason === "disabled") {
      state.operations.subagentsEnabled = false;
    }

    if (reason === "missing-coordinator") {
      state.operations.subagents = undefined;
    }

    const arguments_ =
      reason === "missing-action"
        ? {}
        : { request: { action: "cancel", subagentId: "child" } };
    await expect(
      dispatchModelTool(node("subagent", arguments_), state.operations),
    ).rejects.toThrow(
      reason === "missing-action" ? "缺少结构化操作" : "未开启 subagent",
    );
    expect(state.sequence).toEqual([]);
  },
);

it("acquires execution before a non-wait subagent action", async () => {
  const state = fixture();
  const action: SubagentAction = { action: "cancel", subagentId: "child" };
  const result = await dispatchModelTool(
    node("subagent", { request: action }),
    state.operations,
  );

  expect(result).toBe(state.result);
  expect(state.sequence).toEqual(["execution", "subagent"]);
});

it.each(["host", "runtime"])(
  "keeps %s wait outside execution slots and preserves its completion hook",
  async (mode) => {
    const state = fixture();
    let finishWait!: (value: unknown) => void;
    const waiting = new Promise<unknown>((resolve) => {
      finishWait = resolve;
    });
    state.operations.subagents = {
      async execute() {
        state.sequence.push("waiting");

        return waiting;
      },
    };
    if (mode === "host") {
      state.operations.afterSubagentWait = state.operations.startExecution;
    }

    const pending = dispatchModelTool(
      node("subagent", {
        request: { action: "await", subagentIds: ["child"], timeoutMs: 100 },
      }),
      state.operations,
    );
    expect(state.sequence).toEqual(["waiting"]);
    finishWait(state.result);

    expect(await pending).toBe(state.result);
    expect(state.sequence).toEqual([
      "waiting",
      mode === "host" ? "execution" : "slot-only",
    ]);
  },
);

it("does not acquire a slot or retry when a subagent wait fails", async () => {
  const state = fixture();
  const error = new Error("cancelled or unknown");
  state.operations.subagents = {
    async execute() {
      state.sequence.push("waiting");
      throw error;
    },
  };

  await expect(
    dispatchModelTool(
      node("subagent", {
        request: { action: "await", subagentIds: ["child"], timeoutMs: 100 },
      }),
      state.operations,
    ),
  ).rejects.toBe(error);
  expect(state.sequence).toEqual(["waiting"]);
});

it("propagates a runner failure unchanged without retry", async () => {
  const state = fixture();
  const error = new Error("unknown tool outcome");
  state.operations.runner = {
    forCall() {
      return {
        async execute() {
          state.sequence.push("failed");
          throw error;
        },
      };
    },
  };

  await expect(
    dispatchModelTool(node("run_command"), state.operations),
  ).rejects.toBe(error);
  expect(state.sequence).toEqual(["failed"]);
});
