/**
 * 从已保存的模型交换、工具账本及子任务检查点构造统一的只读工具视图。
 * Store 导出与浏览器投影共用此模块；不依赖 SQLite、Node 或执行器，不修改输入及真实历史。
 *
 * 1. 提取 function_call 的原始参数、身份和唯一模型来源；原生搜索保持在模型输出中。
 * 2. 子检查点补充旧捕获缺少的身份及末轮工具；重复 call_id 按子任务分开，歧义不猜测。
 * 3. 仅从包含相同完整调用的上下文配对 function_call_output；缺失、重复或冲突保持未知。
 * 4. 已有工具账本结果优先；补全条目标记来源，不将模型提出调用冒充已实际执行。
 */

export interface ReplayToolRecord {
  callId: string;
  nodeId: string;
  name: string;
  arguments: unknown;
  dependsOn: string[];
  batchId: string;
  result?: unknown;
  subagentId?: string;
  modelExchangeId?: string;
  recordSource?: "model-output" | "subagent-checkpoint";
}

export interface ReplayModelRecord {
  id: string;
  purpose: string;
  subagentId?: string;
  input: unknown[];
  response?: { output: unknown[] };
}

export interface ReplayChildCheckpoint {
  id: string;
  context: unknown[];
}

interface Call {
  callId: string;
  name: string;
  arguments: string;
  signature: string;
}

interface Candidate {
  call: Call;
  subagentId?: string;
  purpose: string;
  modelExchangeId?: string;
  modelIndex?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCall(value: unknown): Call | undefined {
  const item = record(value);
  if (
    item.type !== "function_call" ||
    typeof item.call_id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.arguments !== "string"
  ) {
    return undefined;
  }

  return {
    callId: item.call_id,
    name: item.name,
    arguments: item.arguments,
    signature: JSON.stringify([item.call_id, item.name, item.arguments]),
  };
}

function decode(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function makeTool(candidate: Candidate): ReplayToolRecord {
  const args = decode(candidate.call.arguments);
  const envelope = record(args);
  const execution = record(envelope.execution);

  return {
    callId: candidate.call.callId,
    name: candidate.call.name,
    arguments:
      "execution" in envelope && "arguments" in envelope
        ? envelope.arguments
        : args,
    nodeId:
      typeof execution.id === "string" ? execution.id : candidate.call.callId,
    dependsOn:
      Array.isArray(execution.dependsOn) &&
      execution.dependsOn.every((id) => typeof id === "string")
        ? execution.dependsOn
        : [],
    batchId: candidate.modelExchangeId ?? `subagent:${candidate.subagentId}`,
    ...(candidate.subagentId === undefined
      ? {}
      : { subagentId: candidate.subagentId }),
    ...(candidate.modelExchangeId === undefined
      ? {}
      : { modelExchangeId: candidate.modelExchangeId }),
    recordSource: candidate.modelExchangeId
      ? "model-output"
      : "subagent-checkpoint",
  };
}

/** 只配对一个上下文内唯一且先于回执的调用；跨模型重复上下文由上层合并。 */
function contextEvidence(context: unknown[]): Map<string, unknown[]> {
  const calls = new Map<string, { call: Call; index: number }[]>();
  const results = new Map<string, { value: unknown; index: number }[]>();
  context.forEach((item, index) => {
    const call = readCall(item);
    if (call) {
      calls.set(call.callId, [
        ...(calls.get(call.callId) ?? []),
        { call, index },
      ]);
    }

    const output = record(item);
    if (
      output.type === "function_call_output" &&
      typeof output.call_id === "string" &&
      output.output !== undefined
    ) {
      results.set(output.call_id, [
        ...(results.get(output.call_id) ?? []),
        { value: decode(output.output), index },
      ]);
    }
  });
  const evidence = new Map<string, unknown[]>();
  for (const [id, matches] of calls) {
    if (matches.length === 1) {
      evidence.set(
        matches[0].call.signature,
        (results.get(id) ?? [])
          .filter((result) => result.index > matches[0].index)
          .map((result) => result.value),
      );
    }
  }

  return evidence;
}

/** 没有子身份的旧账本属于主任务，不能仅凭复用的 call ID 吞掉一个子调用。 */
function matchesTool(tool: ReplayToolRecord, candidate: Candidate): boolean {
  return (
    tool.callId === candidate.call.callId &&
    tool.name === candidate.call.name &&
    tool.subagentId === candidate.subagentId &&
    (tool.modelExchangeId
      ? tool.modelExchangeId === candidate.modelExchangeId
      : tool.subagentId !== undefined || candidate.purpose !== "subagent")
  );
}

function collectCandidates(
  models: readonly ReplayModelRecord[],
  recorded: readonly ReplayToolRecord[],
  children: readonly ReplayChildCheckpoint[],
): Candidate[] {
  const candidates: Candidate[] = [];
  const childSignatures = new Map<string, number>();
  for (const model of models) {
    if (model.purpose === "subagent") {
      for (const item of model.response?.output ?? []) {
        const call = readCall(item);
        if (call) {
          childSignatures.set(
            call.signature,
            (childSignatures.get(call.signature) ?? 0) + 1,
          );
        }
      }
    }
  }

  const childCalls = children.map((child) => ({
    ...child,
    calls: child.context.flatMap((item) => {
      const call = readCall(item);

      return call ? [call] : [];
    }),
  }));
  for (const [modelIndex, model] of models.entries()) {
    for (const item of model.response?.output ?? []) {
      const call = readCall(item);
      if (!call) {
        continue;
      }

      const savedOwners = new Set(
        recorded
          .filter(
            (tool) =>
              tool.modelExchangeId === model.id &&
              tool.subagentId !== undefined,
          )
          .map((tool) => tool.subagentId!),
      );
      const knownChild =
        model.subagentId ??
        (savedOwners.size === 1 ? [...savedOwners][0] : undefined);
      const matches =
        model.purpose === "subagent" && !knownChild
          ? childCalls.filter((child) =>
              child.calls.some((saved) => saved.signature === call.signature),
            )
          : [];
      candidates.push({
        call,
        purpose: model.purpose,
        subagentId:
          knownChild ??
          (matches.length === 1 && childSignatures.get(call.signature) === 1
            ? matches[0].id
            : undefined),
        modelExchangeId: model.id,
        modelIndex,
      });
    }
  }

  for (const child of childCalls) {
    for (const call of child.calls) {
      if (
        !candidates.some(
          (candidate) =>
            candidate.call.signature === call.signature &&
            (candidate.subagentId === child.id ||
              (candidate.purpose === "subagent" &&
                candidate.subagentId === undefined)),
        )
      ) {
        candidates.push({ call, purpose: "subagent", subagentId: child.id });
      }
    }
  }

  return candidates;
}

/** 账本和模型捕获使用不同的序列；关联只依赖身份和完整调用，不依赖时间相邻。 */
export function completeReplayTools(
  models: readonly ReplayModelRecord[],
  recorded: readonly ReplayToolRecord[],
  children: readonly ReplayChildCheckpoint[] = [],
): ReplayToolRecord[] {
  const candidates = collectCandidates(models, recorded, children);
  // 每个完整输入只扫描一次，避免对子任务的每个工具反复遍历累计上下文。
  const evidenceCache = new Map<unknown[], Map<string, unknown[]>>();
  const evidenceFor = (context: unknown[]) => {
    let evidence = evidenceCache.get(context);
    if (!evidence) {
      evidence = contextEvidence(context);
      evidenceCache.set(context, evidence);
    }

    return evidence;
  };

  const tools = recorded.map((tool) => ({ ...tool }));
  for (const candidate of candidates) {
    const matches = tools.filter((tool) => matchesTool(tool, candidate));
    if (!matches.length) {
      tools.push(makeTool(candidate));
    }
  }

  for (const tool of tools) {
    const owners = candidates.filter((candidate) =>
      matchesTool(tool, candidate),
    );
    if (owners.length !== 1) {
      continue;
    }

    const owner = owners[0];
    tool.modelExchangeId ??= owner.modelExchangeId;
    if (tool.result !== undefined) {
      continue;
    }

    // 同一身份重复提出完全相同调用时，不能把某个回执分配给所有请求。
    if (
      candidates.filter(
        (candidate) =>
          candidate.subagentId === owner.subagentId &&
          candidate.purpose === owner.purpose &&
          candidate.call.signature === owner.call.signature,
      ).length !== 1
    ) {
      continue;
    }

    const contexts = models
      .filter(
        (model, index) =>
          (owner.modelIndex === undefined || index > owner.modelIndex) &&
          model.purpose === owner.purpose &&
          (model.subagentId === owner.subagentId ||
            (owner.purpose === "subagent" &&
              !model.subagentId &&
              !owner.subagentId)),
      )
      .map((model) => model.input);
    if (owner.subagentId) {
      contexts.push(
        ...children
          .filter((child) => child.id === owner.subagentId)
          .map((child) => child.context),
      );
    }

    const outputs = new Map<string, unknown>();
    for (const context of contexts) {
      const results = evidenceFor(context).get(owner.call.signature) ?? [];
      if (results.length === 1) {
        const value = results[0];
        outputs.set(JSON.stringify(value), value);
      } else if (results.length > 1) {
        // 重复回执即使正文相同，也不声称这是唯一确认结果。
        outputs.set("ambiguous", undefined);
      }
    }

    if (outputs.size === 1 && !outputs.has("ambiguous")) {
      tool.result = outputs.values().next().value;
    }
  }

  return tools;
}
