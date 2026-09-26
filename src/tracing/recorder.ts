/**
 * 在服务进程内记录任务级性能时间线，并导出 Perfetto 可导入的 Chrome Trace Event JSON。
 * Engine 为每个实际运行的任务调用 startTask/finishTask；模型和工具包装器在真实执行边界创建 span，
 * server/app.ts 通过 exportTask 将已完成或运行中的 trace 作为本地下载接口返回。
 *
 * 1. 单调时钟把 span 和 instant 事件映射到同一个微秒时间轴；task 根使用独立轨道，主线程 span 以可嵌套的 begin/end slice 表示，未结束的子操作会在任务结束时标为实际终态。
 * 2. startSpan/endSpan/instant 接收受控 JSON 属性：普通字符串限长；tool parameters 允许完整结构但递归遮盖凭据字段，避免密钥进入本机 trace。
 * 3. link 保存跨轨道因果关系；exportTask 输出进程/轨道元数据、按时间排序的耗时片段和使用递增整数 ID 的 Perfetto flow 事件。
 * 4. recorder 只保存运行中任务构造完整 JSON 所需的短暂状态；Engine 成功或失败写入 TraceArchive 后立即 discardTask，不保留完成 trace 缓存。
 *
 * 此记录器不参与任务恢复，也不改变工具或模型的执行顺序。记录故障必须不影响 agent 主流程。
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { redactText } from "../logging/redact.js";
import type {
  TraceAttribute,
  TraceAttributes,
  TraceLink,
  TraceSpan,
  TraceSpanOptions,
  TraceStatus,
} from "./types.js";

const MAX_ATTRIBUTE_DEPTH = 20;
const MAX_ATTRIBUTE_LENGTH = 500;
const SENSITIVE_ATTRIBUTE_KEY =
  /^(?:api[_-]?key|authorization|cookie|password|token)$/i;

type TraceRecord = {
  id: string;
  taskId: string;
  sessionId: string;
  spans: Map<string, TraceSpan>;
  instants: Array<{
    name: string;
    category: string;
    track: string;
    timestampUs: number;
    attributes: TraceAttributes;
  }>;
  links: TraceLink[];
  rootSpanId: string;
};

/**
 * 保留工具参数的结构以便本机诊断，同时递归遮盖凭据字段；普通属性仍限制长度，
 * 防止模型原文或工具输出意外成为 trace 存档。Engine 会先遮盖当前 API key，
 * 此处再处理按字段命名出现的通用凭据及 Bearer 文本。
 */
function safeAttribute(
  value: TraceAttribute,
  key: string,
  preserveText: boolean,
  depth = 0,
): TraceAttribute {
  if (value === undefined || value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (SENSITIVE_ATTRIBUTE_KEY.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    const redacted = redactText(value);

    return preserveText ? redacted : redacted.slice(0, MAX_ATTRIBUTE_LENGTH);
  }

  if (depth >= MAX_ATTRIBUTE_DEPTH) {
    return "[TRUNCATED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      safeAttribute(item, key, preserveText, depth + 1),
    );
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([childKey, item]) => [
        childKey,
        safeAttribute(item, childKey, preserveText, depth + 1),
      ]),
  );
}

function safeAttributes(attributes: TraceAttributes = {}): TraceAttributes {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        safeAttribute(value, key, key === "parameters"),
      ]),
  );
}

/** 将逻辑轨道稳定映射为同一 trace 内的数字 tid，避免依赖 Node 真实线程实现细节。 */
function trackIds(record: TraceRecord) {
  const tracks = new Map<string, number>();
  let next = 1;
  const id = (track: string) => {
    let value = tracks.get(track);
    if (value === undefined) {
      value = next++;
      tracks.set(track, value);
    }

    return value;
  };

  for (const span of record.spans.values()) {
    id(span.track);
  }

  for (const instant of record.instants) {
    id(instant.track);
  }

  return { tracks, id };
}

export class TraceRecorder {
  private traces = new Map<string, TraceRecord>();

  /** 使用固定的 wall-clock origin 加单调 performance.now，既可导入 Perfetto，又不受任务期间系统校时影响。 */
  private nowUs() {
    return Math.round((performance.timeOrigin + performance.now()) * 1000);
  }

  startTask(taskId: string, sessionId: string): TraceSpan {
    const existing = this.traces.get(taskId);
    if (existing) {
      return existing.spans.get(existing.rootSpanId)!;
    }

    const root: TraceSpan = {
      id: randomUUID(),
      taskId,
      name: "task.run",
      category: "agent",
      track: "Task",
      startedAtUs: this.nowUs(),
      attributes: safeAttributes({ taskId, sessionId }),
    };
    this.traces.set(taskId, {
      id: randomUUID(),
      taskId,
      sessionId,
      spans: new Map([[root.id, root]]),
      instants: [],
      links: [],
      rootSpanId: root.id,
    });

    return root;
  }

  startSpan(taskId: string, options: TraceSpanOptions): TraceSpan | undefined {
    const record = this.traces.get(taskId);
    if (!record) {
      return undefined;
    }

    const span: TraceSpan = {
      id: randomUUID(),
      taskId,
      name: options.name,
      category: options.category,
      track: options.track,
      parentSpanId: options.parentSpanId ?? record.rootSpanId,
      startedAtUs: this.nowUs(),
      attributes: safeAttributes(options.attributes),
    };
    record.spans.set(span.id, span);

    return span;
  }

  /** 返回同一任务最近创建的指定类别 span，供模型到工具等跨轨道因果关系使用。 */
  latestSpan(taskId: string, category?: string) {
    const record = this.traces.get(taskId);
    if (!record) {
      return undefined;
    }

    let latest: TraceSpan | undefined;
    for (const span of record.spans.values()) {
      if (!category || span.category === category) {
        latest = span;
      }
    }

    return latest;
  }

  endSpan(
    span: TraceSpan | undefined,
    status: TraceStatus,
    attributes: TraceAttributes = {},
  ) {
    if (!span || span.finishedAtUs !== undefined) {
      return;
    }

    span.finishedAtUs = this.nowUs();
    span.status = status;
    Object.assign(span.attributes, safeAttributes(attributes));
  }

  instant(
    taskId: string,
    name: string,
    category: string,
    track: string,
    attributes: TraceAttributes = {},
  ) {
    const record = this.traces.get(taskId);
    if (!record) {
      return;
    }

    record.instants.push({
      name,
      category,
      track,
      timestampUs: this.nowUs(),
      attributes: safeAttributes(attributes),
    });
  }

  link(from: TraceSpan | undefined, to: TraceSpan | undefined, name: string) {
    if (!from || !to || from.taskId !== to.taskId) {
      return;
    }

    const record = this.traces.get(from.taskId);
    if (!record) {
      return;
    }

    record.links.push({
      id: randomUUID(),
      fromSpanId: from.id,
      toSpanId: to.id,
      name,
    });
  }

  finishTask(taskId: string, status: TraceStatus) {
    const record = this.traces.get(taskId);
    if (!record) {
      return;
    }

    const finishedAtUs = this.nowUs();
    for (const span of record.spans.values()) {
      if (span.finishedAtUs === undefined) {
        // 所有未结束的并行操作与根任务共用同一终点，保证根 span 覆盖取消或异常时仍在运行的子操作。
        span.finishedAtUs = finishedAtUs;
        span.status = span.status ?? status;
      }
    }
  }

  /** 任务已经导出并尝试落盘后释放其运行期状态；不可把该方法用于仍在执行的任务。 */
  discardTask(taskId: string) {
    this.traces.delete(taskId);
  }

  /** 返回可直接导入 ui.perfetto.dev 的 JSON；运行中 span 以导出时刻截断，但不会改写其内存状态。 */
  exportTask(taskId: string) {
    const record = this.traces.get(taskId);
    if (!record) {
      return undefined;
    }

    const exportedAtUs = this.nowUs();
    const { tracks, id } = trackIds(record);
    const metadataEvents: any[] = [
      {
        name: "process_name",
        ph: "M",
        pid: process.pid,
        tid: 0,
        args: { name: "CodeAtelier server" },
      },
    ];
    const timelineEvents: any[] = [];

    for (const [track, tid] of tracks) {
      metadataEvents.push({
        name: "thread_name",
        ph: "M",
        pid: process.pid,
        tid,
        args: { name: track },
      });
    }

    for (const span of record.spans.values()) {
      const finishedAtUs = span.finishedAtUs ?? exportedAtUs;
      const args = { ...span.attributes, status: span.status ?? "unknown" };
      const tid = id(span.track);
      if (span.track === "Main thread") {
        // 主线程阶段经常自然嵌套，例如 context.prepare 内的压缩和模型请求。
        // Trace Event 的 X 片段不能在同一 tid 交叠；B/E 保留这种真实调用栈关系。
        timelineEvents.push({
          name: span.name,
          cat: span.category,
          ph: "B",
          ts: span.startedAtUs,
          pid: process.pid,
          tid,
          args,
        });
        timelineEvents.push({
          name: span.name,
          cat: span.category,
          ph: "E",
          ts: finishedAtUs,
          pid: process.pid,
          tid,
        });
      } else {
        timelineEvents.push({
          name: span.name,
          cat: span.category,
          ph: "X",
          ts: span.startedAtUs,
          dur: Math.max(0, finishedAtUs - span.startedAtUs),
          pid: process.pid,
          tid,
          args,
        });
      }
    }

    for (const instant of record.instants) {
      timelineEvents.push({
        name: instant.name,
        cat: instant.category,
        ph: "i",
        s: "t",
        ts: instant.timestampUs,
        pid: process.pid,
        tid: id(instant.track),
        args: instant.attributes,
      });
    }

    for (const [flowIndex, link] of record.links.entries()) {
      const from = record.spans.get(link.fromSpanId);
      const to = record.spans.get(link.toSpanId);
      const fromTimestampUs = from?.finishedAtUs ?? exportedAtUs;
      if (!from || !to || to.startedAtUs < fromTimestampUs) {
        continue;
      }

      // Perfetto 的 Trace Event JSON importer 接受 64 位整数 ID，不接受 UUID 字符串。
      // 因果边只有在源操作结束后目标操作才开始时才有效，逆序边不导出为 flow。
      const flowId = flowIndex + 1;
      timelineEvents.push({
        name: link.name,
        cat: "flow",
        ph: "s",
        ts: fromTimestampUs,
        pid: process.pid,
        tid: id(from.track),
        id: flowId,
      });
      timelineEvents.push({
        name: link.name,
        cat: "flow",
        ph: "f",
        ts: to.startedAtUs,
        pid: process.pid,
        tid: id(to.track),
        id: flowId,
      });
    }

    timelineEvents.sort((left, right) => {
      if (left.ts !== right.ts) {
        return left.ts - right.ts;
      }

      if (left.ph === "E") {
        return -1;
      }

      if (right.ph === "E") {
        return 1;
      }

      if (left.ph === "s") {
        return -1;
      }

      if (right.ph === "s") {
        return 1;
      }

      if (left.ph === "f") {
        return 1;
      }

      if (right.ph === "f") {
        return -1;
      }

      return 0;
    });

    return {
      traceEvents: [...metadataEvents, ...timelineEvents],
      displayTimeUnit: "ms",
      metadata: {
        traceId: record.id,
        taskId: record.taskId,
        sessionId: record.sessionId,
        format: "CodeAtelier Perfetto Trace Event JSON v1",
      },
    };
  }
}
