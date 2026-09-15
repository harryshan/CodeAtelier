/**
 * 在独立线程完成上下文压缩的 CPU 密集转换，避免长历史阻塞 Fastify 的事件循环。
 * compaction-worker-client 为每次压缩创建本 Worker；ContextManager 保留模型请求、文件哈希探测和
 * SQLite 提交，向这里发送已读取的历史、事件和快照链。
 *
 * 1. prepare 使用与主任务一致的计量配置寻找安全切分，恢复祖先快照正文，建立工具来源索引和执行账本，
 *    然后返回可由主线程安全探测的文件版本。
 * 2. transform 使用索引完成一级读取投影和二级工具投影，并在 Worker 中验收压缩收益。
 * 3. chunks 仅在需要三级摘要时按摘要模型预算分块；网络模型调用仍由主线程负责，以保留取消和重试语义。
 * 4. finalize 将模型返回的摘要组合为新上下文和快照元数据，计算 hash/字符数和最终预算验收。
 *
 * Worker 不访问工作区、不调用模型、不写 SQLite。所有输入都是已保存历史数据，不能据此推断工具成功或权限。
 */

import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { chooseCut, contextSize } from "./budget.js";
import { summaryChunks } from "./compactor.js";
import { mechanicalInput } from "./mechanical-input.js";
import { projectReads, readHashCandidates } from "./read-projection.js";
import { projectToolResults } from "./tool-projection.js";
import { executionLedger } from "./snapshot.js";
import { measureContext, type ContextMeasurement } from "./token-budget.js";
import { createToolResultIndex, type ToolResultIndex } from "./tool-result.js";
import type { ContextSnapshot } from "./types.js";
import type { Event } from "../shared/types.js";

interface PreparedState {
  input: any[];
  prefix: any[];
  tail: any[];
  events: Event[];
  snapshots: ContextSnapshot[];
  expanded: any[];
  prefixIndex: ToolResultIndex;
  ledger: ContextSnapshot["ledger"];
  retained?: any[];
  selected?: ContextSnapshot["stage"];
  selectedInput?: any[];
}

let state: PreparedState | undefined;

function measure(
  measurement: ContextMeasurement,
  input: any[],
  instructions: string,
  tools: any[],
) {
  return measureContext(
    measurement,
    mechanicalInput(input),
    instructions,
    tools,
  );
}

function restoreHistory(prefix: any[], snapshots: ContextSnapshot[]) {
  const trustedNotes = new Set<string>();
  const expanded = prefix.map((item) => ({ ...item }));
  for (const ancestor of snapshots) {
    for (const projection of ancestor.projections ?? []) {
      const original = ancestor.source[projection.index];
      for (const item of expanded) {
        if (
          item.type === "function_call_output" &&
          item.call_id === original?.call_id &&
          item.output === projection.output
        ) {
          item.output = original.output;
        }
      }
    }

    if (ancestor.note) {
      trustedNotes.add(ancestor.note);
    }
  }

  return { expanded, trustedNotes };
}

function acceptable(
  candidate: any[],
  current: PreparedState,
  measurement: ContextMeasurement,
  instructions: string,
  tools: any[],
  limit: number,
  beforeAmount: number,
) {
  if (candidate.every((item, index) => item === current.input[index])) {
    return false;
  }

  const amount = measure(measurement, candidate, instructions, tools);

  return amount <= limit * 0.6 && amount < beforeAmount * 0.9;
}

function prepare(request: {
  input: any[];
  events: Event[];
  snapshots: ContextSnapshot[];
  measurement: ContextMeasurement;
  limit: number;
  instructions: string;
  tools: any[];
}) {
  const localMeasure = (input: any[], instructions: string, tools: any[]) =>
    measure(request.measurement, input, instructions, tools);
  const cut = chooseCut(request.input, request.limit, localMeasure);
  if (cut === undefined) {
    return { planned: false as const };
  }

  const prefix = request.input.slice(0, cut);
  const anchors = prefix.filter((item) => item.role === "user");
  const tail = request.input.slice(cut);
  if (
    localMeasure([...anchors, ...tail], request.instructions, request.tools) >=
    request.limit * 0.6
  ) {
    return { planned: false as const };
  }

  const { expanded, trustedNotes } = restoreHistory(prefix, request.snapshots);
  const prefixIndex = createToolResultIndex(prefix, request.events);
  const expandedIndex = createToolResultIndex(expanded, request.events);
  const ledger = executionLedger(
    expanded,
    request.events,
    request.snapshots[0],
    expandedIndex,
  );
  state = {
    input: request.input,
    prefix,
    tail,
    events: request.events,
    snapshots: request.snapshots,
    expanded,
    prefixIndex,
    ledger,
  };

  return {
    planned: true as const,
    readCandidates: readHashCandidates(prefix, request.events, prefixIndex),
    ledger,
    trustedNotes: [...trustedNotes],
  };
}

function transform(request: {
  snapshotId: string;
  hashes: Array<[string, string | undefined]>;
  measurement: ContextMeasurement;
  limit: number;
  beforeAmount: number;
  instructions: string;
  tools: any[];
  trustedNotes: string[];
}) {
  if (!state) {
    throw new Error("压缩 Worker 尚未准备历史。");
  }

  const hashes = new Map(request.hashes);
  const deduplicated = [
    ...projectReads(
      state.prefix,
      request.snapshotId,
      state.events,
      "deduplicate",
      hashes,
      state.prefixIndex,
    ),
    ...state.tail,
  ];
  if (
    acceptable(
      deduplicated,
      state,
      request.measurement,
      request.instructions,
      request.tools,
      request.limit,
      request.beforeAmount,
    )
  ) {
    state.selected = "deduplicate";
    state.selectedInput = deduplicated;

    return { stage: "deduplicate" as const, requiresSummary: false };
  }

  const readsArchived = projectReads(
    state.prefix,
    request.snapshotId,
    state.events,
    "archive",
    hashes,
    state.prefixIndex,
  );
  const archived = [
    ...projectToolResults(
      readsArchived,
      request.snapshotId,
      state.events,
      state.prefixIndex,
    ),
    ...state.tail,
  ];
  if (
    acceptable(
      archived,
      state,
      request.measurement,
      request.instructions,
      request.tools,
      request.limit,
      request.beforeAmount,
    )
  ) {
    state.selected = "archive";
    state.selectedInput = archived;

    return { stage: "archive" as const, requiresSummary: false };
  }

  const trustedNotes = new Set(request.trustedNotes);
  const excluded = new Set<number>();
  const retained = state.prefix.filter((item, index) => {
    if (
      item.role === "user" ||
      (item.role === "assistant" && trustedNotes.has(item.content))
    ) {
      excluded.add(index);

      return true;
    }

    return false;
  });
  if (
    measure(
      request.measurement,
      [...retained, ...state.tail],
      request.instructions,
      request.tools,
    ) >=
    request.limit * 0.6
  ) {
    throw new Error("保留的用户要求与历史摘要已超出压缩目标。");
  }

  state.retained = retained;
  state.selected = "summary";

  return { stage: "summary" as const, requiresSummary: true };
}

function chunks(request: { measurement: ContextMeasurement; limit: number }) {
  if (!state?.retained) {
    throw new Error("压缩 Worker 尚未准备摘要分块。");
  }

  const retained = new Set(state.retained);
  const excluded = new Set<number>();
  for (const [index, item] of state.prefix.entries()) {
    if (retained.has(item)) {
      excluded.add(index);
    }
  }

  return summaryChunks(
    state.expanded,
    request.limit,
    (input, instructions, tools) =>
      measureContext(request.measurement, input, instructions, tools),
    excluded,
  );
}

function finalize(request: {
  id: string;
  sessionId: string;
  parentId: string | null;
  model: string;
  beforeAmount: number;
  limit: number;
  unit: "tokens" | "characters";
  measurement: ContextMeasurement;
  instructions: string;
  tools: any[];
  note?: string;
  summaries: ContextSnapshot["summaries"];
}) {
  if (!state?.selected) {
    throw new Error("压缩 Worker 尚未选择压缩阶段。");
  }

  const current = state;
  const stage = current.selected;
  const finalInput =
    stage === "summary"
      ? [
          ...(current.retained ?? []),
          { role: "assistant", content: request.note },
          ...current.tail,
        ]
      : current.selectedInput;
  if (!finalInput) {
    throw new Error("压缩 Worker 缺少已验收的上下文。");
  }

  const after = measure(
    request.measurement,
    finalInput,
    request.instructions,
    request.tools,
  );
  if (after > request.limit * 0.6 || after >= request.beforeAmount * 0.9) {
    throw new Error("摘要未达到压缩目标。");
  }

  const snapshot: ContextSnapshot = {
    version: 1,
    stage,
    note: request.note,
    projections:
      stage === "summary"
        ? undefined
        : finalInput
            .slice(0, current.prefix.length)
            .flatMap((item, index) =>
              item.type === "function_call_output" &&
              item.output !== current.input[index]?.output
                ? [{ index, output: item.output }]
                : [],
            ),
    id: request.id,
    sessionId: request.sessionId,
    parentId: request.parentId,
    sourceHash: createHash("sha256")
      .update(JSON.stringify(current.input))
      .digest("hex"),
    model: request.model,
    createdAt: new Date().toISOString(),
    beforeChars: contextSize(
      current.input,
      request.instructions,
      request.tools,
    ),
    afterChars: contextSize(finalInput, request.instructions, request.tools),
    budget: {
      unit: request.unit,
      limit: request.limit,
      before: request.beforeAmount,
      after,
    },
    cut: current.prefix.length,
    source: current.input,
    summaries: request.summaries,
    ledger: current.ledger,
  };

  return { input: finalInput, snapshot };
}

parentPort?.on(
  "message",
  (message: { id: number; type: string; data: any }) => {
    try {
      const value =
        message.type === "prepare"
          ? prepare(message.data)
          : message.type === "transform"
            ? transform(message.data)
            : message.type === "chunks"
              ? chunks(message.data)
              : message.type === "finalize"
                ? finalize(message.data)
                : (() => {
                    throw new Error("未知的压缩 Worker 操作。");
                  })();
      parentPort?.postMessage({ id: message.id, ok: true, value });
    } catch (error) {
      parentPort?.postMessage({
        id: message.id,
        ok: false,
        error:
          error instanceof Error ? error.message : "压缩 Worker 执行失败。",
      });
    }
  },
);
