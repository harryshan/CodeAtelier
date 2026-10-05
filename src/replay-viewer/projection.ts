/**
 * 将手动导出的任务 JSON 校验并投影为离线阅读器的导航条目，不依赖 Store 或工具执行器。
 * browser.ts 与回归测试共享这些纯函数；输入为不可信 JSON，输出只含展示数据和可靠的调用关联。
 *
 * 1. caseSchema 仅约束阅读所需字段，保留扩展字段；parseReplayCase 拒绝错误版本和损坏结构。
 * 2. record/formatValue 与 outcome 处理任意载荷，缺少结果保持 unknown，有结果不等同成功。
 * 3. projectReplay 按捕获顺序编号模型请求，仅用唯一 function_call.call_id 关联工具；不靠时间猜测。
 * 4. filterEntries 在用户主动搜索时检索原始条目；事件保持独立序列，不冒充模型/工具的统一时钟。
 *
 * 不修改导出材料、不执行其代码或命令，不把 legacy、重试或中断记录补造成完整 transcript。
 */

import { z } from "zod";

const toolSchema = z
  .object({
    callId: z.string(),
    nodeId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
    dependsOn: z.array(z.string()),
    batchId: z.string(),
    result: z.unknown().optional(),
  })
  .passthrough();

const exchangeSchema = z
  .object({
    id: z.string(),
    purpose: z.string(),
    step: z.number().optional(),
    attempt: z.number().optional(),
    input: z.array(z.unknown()),
    instructions: z.string(),
    tools: z.array(z.unknown()),
    response: z
      .object({
        text: z.string(),
        output: z.array(z.unknown()),
        usage: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const caseSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.enum(["captured", "legacy"]),
    session: z
      .object({ title: z.string(), workspace: z.string() })
      .passthrough(),
    task: z.object({ id: z.string(), status: z.string() }).passthrough(),
    capture: z
      .object({
        schemaVersion: z.literal(1),
        modelExchanges: z.array(exchangeSchema),
      })
      .passthrough()
      .optional(),
    tools: z.array(toolSchema),
    events: z.array(
      z
        .object({
          id: z.number(),
          type: z.string(),
          createdAt: z.string(),
          data: z.unknown(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type ViewerCase = z.infer<typeof caseSchema>;
export type Exchange = z.infer<typeof exchangeSchema>;
export type Tool = z.infer<typeof toolSchema>;
export type EntryStatus = "recorded" | "error" | "unknown";
export type EntryKind = "model" | "tool" | "event";
export interface ViewerEntry {
  key: string;
  kind: EntryKind;
  title: string;
  subtitle: string;
  status: EntryStatus;
  raw: unknown;
  exchange?: Exchange;
  tool?: Tool;
  modelKey?: string;
  toolKeys: string[];
}

export const statusLabels: Record<EntryStatus, string> = {
  recorded: "已记录",
  error: "异常",
  unknown: "结果未知",
};

export function parseReplayCase(value: unknown): ViewerCase {
  const parsed = caseSchema.safeParse(value);
  if (!parsed.success) {
    const location = parsed.error.issues[0]?.path.join(".") || "根节点";
    throw new Error(
      `不是有效的 CodeAtelier Replay Case v1（${location}）。请选择 replay:export 导出的任务 JSON。`,
    );
  }

  return parsed.data;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function formatValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "未记录");
}

function outcome(value: unknown): EntryStatus {
  if (value === undefined) {
    return "unknown";
  }

  const result = record(value);
  if (
    result.error ||
    result.isError === true ||
    result.success === false ||
    (typeof result.exitCode === "number" && result.exitCode !== 0) ||
    ["failed", "blocked", "cancelled", "interrupted"].includes(
      String(result.status),
    ) ||
    (Array.isArray(result.files) &&
      result.files.some((file) => record(file).status === "failed"))
  ) {
    return "error";
  }

  // 有返回载荷只说明记录存在，不能为任意工具格式推导执行成功。
  return "recorded";
}

export function projectReplay(data: ViewerCase): ViewerEntry[] {
  const owners = new Map<string, ViewerEntry[]>();
  const models: ViewerEntry[] = (data.capture?.modelExchanges ?? []).map(
    (exchange, index) => {
      const entry: ViewerEntry = {
        key: `model-${index}`,
        kind: "model",
        title: `模型调用 #${index + 1} · ${exchange.purpose}`,
        subtitle: `step ${exchange.step ?? "未记录"} · attempt ${exchange.attempt ?? "未记录"} · ${exchange.id}`,
        status:
          exchange.error !== undefined
            ? "error"
            : exchange.response
              ? "recorded"
              : "unknown",
        raw: exchange,
        exchange,
        toolKeys: [],
      };
      const ids = new Set(
        (exchange.response?.output ?? []).flatMap((item) => {
          const call = record(item);

          return call.type === "function_call" &&
            typeof call.call_id === "string"
            ? [call.call_id]
            : [];
        }),
      );
      for (const id of ids) {
        owners.set(id, [...(owners.get(id) ?? []), entry]);
      }

      return entry;
    },
  );
  const tools: ViewerEntry[] = data.tools.map((tool, index) => {
    const candidates = owners.get(tool.callId);
    const owner = candidates?.length === 1 ? candidates[0] : undefined;
    const key = `tool-${index}`;
    owner?.toolKeys.push(key);

    return {
      key,
      kind: "tool",
      title: `工具 #${index + 1} · ${tool.name}`,
      subtitle: `${owner?.title ?? "未关联模型调用"} · ${tool.nodeId} · ${tool.callId}`,
      status: outcome(tool.result),
      raw: tool,
      tool,
      modelKey: owner?.key,
      toolKeys: [],
    };
  });
  const events: ViewerEntry[] = data.events.map((event, index) => ({
    key: `event-${index}`,
    kind: "event",
    title: `事件 #${event.id} · ${event.type}`,
    subtitle: event.createdAt,
    status: "recorded",
    raw: event,
    toolKeys: [],
  }));

  return [...models, ...tools, ...events];
}

export function filterEntries(
  entries: ViewerEntry[],
  view: string,
  status: string,
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase();

  return entries.filter((entry) => {
    const included =
      view === "rounds"
        ? entry.kind === "model" || (entry.kind === "tool" && !entry.modelKey)
        : entry.kind === view;
    if (!included || (status && entry.status !== status)) {
      return false;
    }

    return (
      !needle ||
      `${entry.title}\n${entry.subtitle}\n${JSON.stringify(entry.raw)}`
        .toLocaleLowerCase()
        .includes(needle)
    );
  });
}
