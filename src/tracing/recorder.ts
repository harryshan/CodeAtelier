/**
 * 在服务进程内记录任务级性能时间线，并导出 Perfetto 可导入的 Chrome Trace Event JSON。
 * Engine 为每个实际运行的任务调用 startTask/finishTask；模型和工具包装器在真实执行边界创建 span，
 * Engine 在终态通过 exportTask 生成归档；server/app.ts 只下载已经落盘的文件。
 *
 * 1. 本进程单调时钟和已认证 Runtime 报时映射到微秒时间轴；业务生命周期用进程内独立 ID 的异步 b/e 配对，允许交叉结束，未结束片段由任务终态收口。
 * 2. startSpan/endSpan/instant 接收受控 JSON 属性：普通字符串限长；tool parameters 允许完整结构但递归遮盖凭据字段，避免密钥进入本机 trace。
 * 3. link 保存跨轨道因果关系；exportTask 保留逻辑轨道和父 span 属性，通过异步 n 事件及 bind_id 将 flow 绑定到正确生命周期；同刻事件按开始/端点/结束的约束排序。
 * 4. recorder 只保存运行中任务构造完整 JSON 所需的短暂状态；Engine 成功或失败写入 TraceArchive 后立即 discardTask，不保留完成 trace 缓存。
 *
 * 此记录器不参与任务恢复，也不改变工具或模型的执行顺序。记录故障必须不影响 agent 主流程。
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isCredentialKey, redactText } from "../logging/redact.js";
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
    processId: number;
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
  if (isCredentialKey(key)) {
    return "[REDACTED]";
  }

  if (value === undefined || value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
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
  const tracks = new Map<number, Map<string, number>>();
  const id = (processId: number, track: string) => {
    let processTracks = tracks.get(processId);
    if (!processTracks) {
      processTracks = new Map();
      tracks.set(processId, processTracks);
    }

    let value = processTracks.get(track);
    if (value === undefined) {
      value = processTracks.size + 1;
      processTracks.set(track, value);
    }

    return value;
  };

  for (const span of record.spans.values()) {
    id(span.processId ?? process.pid, span.track);
  }

  for (const instant of record.instants) {
    id(instant.processId, instant.track);
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
      processId: options.processId,
      parentSpanId: options.parentSpanId ?? record.rootSpanId,
      startedAtUs: options.startedAtUs ?? this.nowUs(),
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
    finishedAtUs?: number,
  ) {
    if (!span || span.finishedAtUs !== undefined) {
      return;
    }

    span.finishedAtUs = Math.max(
      span.startedAtUs,
      finishedAtUs ?? this.nowUs(),
    );
    span.status = status;
    Object.assign(span.attributes, safeAttributes(attributes));
  }

  instant(
    taskId: string,
    name: string,
    category: string,
    track: string,
    attributes: TraceAttributes = {},
    processId = process.pid,
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
      processId,
      attributes: safeAttributes(attributes),
    });
  }

  /** 不信任跨进程报时：只接受本任务开始之后且不超前 Broker 当前时间的有限误差。 */
  acceptExternalTime(taskId: string, timestampUs: number) {
    const record = this.traces.get(taskId);
    const root = record?.spans.get(record.rootSpanId);

    return (
      Number.isSafeInteger(timestampUs) &&
      root !== undefined &&
      timestampUs >= root.startedAtUs - 5_000_000 &&
      timestampUs <= this.nowUs() + 5_000_000
    );
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
        // 未结束操作按任务终态收口；跨进程报时略超前时保留零长区间，不能导出负耗时。
        span.finishedAtUs = Math.max(span.startedAtUs, finishedAtUs);
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
    const timelineEvents: Array<{ event: any; order: number }> = [];
    const spanIds = new Map(
      [...record.spans.keys()].map((spanId, index) => [
        spanId,
        (index + 1).toString(16),
      ]),
    );
    const endpoint = (span: TraceSpan) => ({
      pid: span.processId ?? process.pid,
      tid: id(span.processId ?? process.pid, span.track),
      id2: { local: spanIds.get(span.id)! },
    });

    for (const [processId, processTracks] of tracks) {
      if (processId !== process.pid) {
        metadataEvents.push({
          name: "process_name",
          ph: "M",
          pid: processId,
          tid: 0,
          args: { name: "Agent Runtime" },
        });
      }

      for (const [track, tid] of processTracks) {
        metadataEvents.push({
          name: "thread_name",
          ph: "M",
          pid: processId,
          tid,
          args: { name: track },
        });
      }
    }

    for (const span of record.spans.values()) {
      const finishedAtUs = Math.max(
        span.startedAtUs,
        span.finishedAtUs ?? exportedAtUs,
      );
      const args = {
        ...span.attributes,
        status: span.status ?? "unknown",
        spanId: span.id,
        parentSpanId: span.parentSpanId,
        logicalTrack: span.track,
      };
      // 所有 span 都描述从开始到完成的生命周期，不借助轨道名称假定 JS 调用栈或 CPU 执行。
      // Perfetto 按进程/名称复用异步轨道；id2.local 负责配对，原槽位保留在 tid/logicalTrack。
      timelineEvents.push({
        order: 3,
        event: {
          name: span.name,
          cat: span.category,
          ph: "b",
          ts: span.startedAtUs,
          ...endpoint(span),
          args,
        },
      });
      timelineEvents.push({
        // 先关闭已有区间以复用轨道；零时长区间必须先 begin，再处理端点，最后 end。
        order: finishedAtUs === span.startedAtUs ? 6 : 2,
        event: {
          name: span.name,
          cat: span.category,
          ph: "e",
          ts: finishedAtUs,
          ...endpoint(span),
        },
      });
    }

    for (const instant of record.instants) {
      timelineEvents.push({
        order: 7,
        event: {
          name: instant.name,
          cat: instant.category,
          ph: "i",
          s: "t",
          ts: instant.timestampUs,
          pid: instant.processId,
          tid: id(instant.processId, instant.track),
          args: instant.attributes,
        },
      });
    }

    for (const [flowIndex, link] of record.links.entries()) {
      const from = record.spans.get(link.fromSpanId);
      const to = record.spans.get(link.toSpanId);
      const fromTimestampUs = from?.finishedAtUs ?? exportedAtUs;
      if (!from || !to || to.startedAtUs < fromTimestampUs) {
        continue;
      }

      // s/f 绑定同步线程轨道，不能连接 b/e。n 沿用生命周期的 id2，在其内创建零时长端点，
      // n 必须沿用 span 的名称和分类，否则 importer 会另建轨道；关系名放在 flowName 属性。
      // bind_id 把这两个端点连成 flow；支持一个模型响应派生多个工具，且不改写实测时间。
      const flowId = flowIndex + 1;
      timelineEvents.push({
        order: fromTimestampUs === from.startedAtUs ? 4 : 0,
        event: {
          name: from.name,
          cat: from.category,
          ph: "n",
          ts: fromTimestampUs,
          ...endpoint(from),
          bind_id: flowId,
          flow_out: true,
          args: { flowName: link.name, spanId: from.id },
        },
      });
      timelineEvents.push({
        order: 5,
        event: {
          name: to.name,
          cat: to.category,
          ph: "n",
          ts: to.startedAtUs,
          ...endpoint(to),
          bind_id: flowId,
          flow_in: true,
          args: { flowName: link.name, spanId: to.id },
        },
      });
    }

    timelineEvents.sort(
      (left, right) =>
        left.event.ts - right.event.ts || left.order - right.order,
    );

    return {
      traceEvents: [
        ...metadataEvents,
        ...timelineEvents.map(({ event }) => event),
      ],
      displayTimeUnit: "ms",
      metadata: {
        traceId: record.id,
        taskId: record.taskId,
        sessionId: record.sessionId,
        format: "CodeAtelier Perfetto Trace Event JSON v2",
      },
    };
  }
}
