/**
 * 将本机 trace 归档或运行中快照整理为唯一的用户下载时间线；由 server/app.ts 调用。
 * 输入为已脱敏的 JSON 文本，输出为 Perfetto JSON；不写文件、不修改采集器或任务状态。
 *
 * 1. readSlices 按 ID 还原 v2 异步区间，也兼容旧 X 和 B/E；缺少结束只保留 unknown 零时长，不猜耗时。
 * 2. describeSlice 只选择主流程和明显等待，隐藏 SQL、IPC、采样及正常内部步骤；异常始终保留。
 * 3. simpleArguments 只带少量定位字段，排除工具参数与正文；标签采用固定英文名称。
 * 4. simplifyTrace 按真实进程和类别复用逻辑行，重叠区间分行，输出 X 事件与稳定排序元数据。
 *
 * 逻辑行不是物理线程，区间仍是墙钟时间，不代表 CPU 占用；不相加、不改写时间戳来制造嵌套。
 * 原始归档及 droppedRecords/partial 等事实保留，下载不会提供额外的详细版入口。
 */

interface Event {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  cat?: string;
  id?: string | number;
  id2?: { local?: string | number; global?: string | number };
  args?: Record<string, unknown>;
}

type Slice = Event & { dur: number; args: Record<string, unknown> };
const groups = [
  "Task",
  "Model",
  "Tools",
  "Waiting",
  "Context",
  "Storage",
  "Runtime",
  "Issues",
] as const;
type Group = (typeof groups)[number];
type Description = { group: Group; label: string };
const MIN_DETAIL_US = 10_000;

const stages: Record<string, Description> = {
  "task.run": { group: "Task", label: "Task" },
  "task.queue": { group: "Waiting", label: "Task queue" },
  "llm.request": { group: "Model", label: "Model request" },
  "llm.capabilities": { group: "Model", label: "Model capabilities" },
  "llm.retry_delay": { group: "Waiting", label: "Retry delay" },
  "approval.classify": { group: "Waiting", label: "Approval check" },
  "approval.human_wait": { group: "Waiting", label: "User approval" },
  "tool.dependency_wait": { group: "Waiting", label: "Tool dependencies" },
  "tool.slot_wait": { group: "Waiting", label: "Tool slot" },
  "mcp.queue": { group: "Waiting", label: "MCP queue" },
  "context.prepare": { group: "Context", label: "Prepare context" },
  "context.request": { group: "Context", label: "Build request" },
  "context.compaction": { group: "Context", label: "Compact context" },
  "tool.result_persist": { group: "Storage", label: "Save tool results" },
  "broker.command": { group: "Tools", label: "Host command" },
  "tool.read_file": { group: "Tools", label: "Read file" },
  "tool.edit_files": { group: "Tools", label: "Edit files" },
  "tool.run_command": { group: "Tools", label: "Run command" },
  "tool.run_with_permissions": {
    group: "Tools",
    label: "Wait for host command",
  },
  "tool.memory_apply": { group: "Tools", label: "Project memory" },
  "tool.read_context_history": { group: "Tools", label: "Read history" },
  "tool.skill": { group: "Tools", label: "Skill" },
  "tool.mcp": { group: "Tools", label: "MCP" },
  "tool.subagent": { group: "Tools", label: "Subagent" },
};

const modelLabels: Record<string, string> = {
  task: "Model request",
  title: "Generate title",
  compaction: "Summarize context",
  approval: "Review permission",
  subagent: "Subagent model",
  tool_review: "Review running tool",
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** ID 的作用域包括进程和事件名，不能把不同 Runtime 的同名 local ID 配到一起。 */
function asyncKey(event: Event) {
  const global = event.id2?.global;
  const local = event.id2?.local ?? event.id;
  const id = global ?? local;
  if (typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }

  return JSON.stringify([
    global === undefined ? event.pid : "global",
    event.cat,
    event.name,
    id,
  ]);
}

function readSlices(events: unknown[]) {
  const slices: Slice[] = [];
  const asyncStarts = new Map<string, Event>();
  const stacks = new Map<string, Event[]>();
  let unpairedSpans = 0;
  const finish = (start: Event, end?: Event) => {
    const validEnd = end !== undefined && end.ts >= start.ts;
    if (!validEnd) {
      unpairedSpans++;
    }

    slices.push({
      ...start,
      dur: validEnd ? end.ts - start.ts : 0,
      args: {
        ...start.args,
        ...end?.args,
        ...(!validEnd ? { status: "unknown" } : {}),
      },
    });
  };

  for (const value of events) {
    const raw = object(value);
    if (
      !Number.isFinite(raw.pid) ||
      !Number.isFinite(raw.ts) ||
      typeof raw.ph !== "string"
    ) {
      continue;
    }

    const event = {
      ...raw,
      name: typeof raw.name === "string" ? raw.name : "",
      tid: Number.isFinite(raw.tid) ? raw.tid : 0,
      args: object(raw.args),
    } as Event;
    if (event.ph === "X" && Number.isFinite(event.dur) && event.dur! >= 0) {
      slices.push({ ...event, dur: event.dur!, args: event.args! });
    } else if (event.ph === "b" || event.ph === "e") {
      const key = asyncKey(event);
      if (key === undefined) {
        continue;
      }

      const start = asyncStarts.get(key);
      if (event.ph === "b") {
        if (start) {
          finish(start);
        }

        asyncStarts.set(key, event);
      } else if (start) {
        finish(start, event);
        asyncStarts.delete(key);
      }
    } else if (event.ph === "B" || event.ph === "E") {
      const key = `${event.pid}:${event.tid}`;
      const stack = stacks.get(key) ?? [];
      if (event.ph === "B") {
        stack.push(event);
        stacks.set(key, stack);
      } else {
        const start = stack.pop();
        if (start) {
          finish(start, event);
        }
      }
    } else if (event.ph === "i" && isIssue(event.args?.status)) {
      slices.push({ ...event, dur: 0, args: event.args! });
    }
  }

  for (const start of asyncStarts.values()) {
    finish(start);
  }

  for (const stack of stacks.values()) {
    for (const start of stack) {
      finish(start);
    }
  }

  return { slices, unpairedSpans };
}

function isIssue(status: unknown) {
  return status === "error" || status === "cancelled" || status === "unknown";
}

function readableOperation(name: string) {
  if (!/^[a-zA-Z0-9_. -]+$/.test(name)) {
    return "Operation";
  }

  const text = name.replace(/[_.]+/g, " ");

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeSlice(slice: Slice): Description | undefined {
  let description = stages[slice.name];
  if (slice.name === "llm.request") {
    description = {
      group: "Model",
      label: modelLabels[String(slice.args.purpose)] ?? "Model request",
    };
  } else if (slice.name.startsWith("sandbox.")) {
    description = { group: "Runtime", label: readableOperation(slice.name) };
  } else if (
    slice.name.startsWith("store.") &&
    !slice.name.startsWith("store.worker.") &&
    slice.name !== "store.queue"
  ) {
    description = { group: "Storage", label: "Database operation" };
  }

  if (isIssue(slice.args.status)) {
    return {
      group: description?.group ?? "Issues",
      label: `${description?.label ?? readableOperation(slice.name)} [${slice.args.status}]`,
    };
  }

  // 不以持续时间隐藏主模型、真实工具或上下文；仅对零碎等待、数据库往返和环境阶段降噪。
  if (
    description &&
    (description.group === "Waiting" ||
      description.group === "Runtime" ||
      description.label === "Database operation" ||
      slice.name === "llm.capabilities") &&
    slice.dur < MIN_DETAIL_US
  ) {
    return undefined;
  }

  return description;
}

function simpleArguments(slice: Slice) {
  const args: Record<string, unknown> = { operation: slice.name };
  for (const key of [
    "status",
    "spanId",
    "callId",
    "requestId",
    "step",
    "attempt",
    "purpose",
    "model",
    "protocol",
    "inputTokens",
    "outputTokens",
    "reason",
    "executionMode",
    "runtimeKind",
    "errorName",
    "errorCode",
  ]) {
    const value = slice.args[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      args[key] = value;
    }
  }

  return args;
}

export function simplifyTrace(source: string) {
  const trace = object(JSON.parse(source));
  if (!Array.isArray(trace.traceEvents)) {
    throw new TypeError("Invalid trace archive");
  }

  const { slices, unpairedSpans } = readSlices(trace.traceEvents);
  const selected = slices
    .flatMap((slice) => {
      const description = describeSlice(slice);

      return description ? [{ slice, ...description }] : [];
    })
    .sort(
      (left, right) =>
        left.slice.ts - right.slice.ts || left.slice.dur - right.slice.dur,
    );
  const lanes = new Map<string, Array<{ end: number; tid: number }>>();
  const processIds = new Set<number>();
  const metadataEvents: Record<string, unknown>[] = [];
  const timeline: Record<string, unknown>[] = [];
  let nextTid = 1;
  for (const { slice, group, label } of selected) {
    if (!processIds.has(slice.pid)) {
      processIds.add(slice.pid);
      const sourceProcess = trace.traceEvents.find((value) => {
        const event = object(value);

        return (
          event.ph === "M" &&
          event.name === "process_name" &&
          event.pid === slice.pid
        );
      });
      const sourceName = object(object(sourceProcess).args).name;
      metadataEvents.push({
        ph: "M",
        name: "process_name",
        pid: slice.pid,
        tid: 0,
        args: {
          name:
            sourceName === "Agent Runtime" ? "Agent Runtime" : "CodeAtelier",
        },
      });
    }

    const key = `${slice.pid}:${group}`;
    const available = lanes.get(key) ?? [];
    let lane = available.find((candidate) => candidate.end <= slice.ts);
    if (!lane) {
      lane = { tid: nextTid++, end: 0 };
      available.push(lane);
      lanes.set(key, available);
      const name =
        available.length === 1 ? group : `${group} ${available.length}`;
      metadataEvents.push(
        {
          ph: "M",
          name: "thread_name",
          pid: slice.pid,
          tid: lane.tid,
          args: { name },
        },
        {
          ph: "M",
          name: "thread_sort_index",
          pid: slice.pid,
          tid: lane.tid,
          args: {
            sort_index: groups.indexOf(group) * 100_000 + available.length,
          },
        },
      );
    }

    lane.end = slice.ts + slice.dur;
    timeline.push({
      name: label,
      cat: group,
      ph: "X",
      pid: slice.pid,
      tid: lane.tid,
      ts: slice.ts,
      dur: slice.dur,
      args: simpleArguments(slice),
    });
  }

  return {
    traceEvents: [...metadataEvents, ...timeline],
    displayTimeUnit: "ms",
    metadata: {
      ...object(trace.metadata),
      sourceFormat: object(trace.metadata).format,
      format: "CodeAtelier simple trace v1",
      view: "simple",
      displayedSpans: selected.length,
      hiddenSpans: slices.length - selected.length,
      unpairedSpans,
      minimumDetailMs: MIN_DETAIL_US / 1000,
      timing:
        "Wall time; logical lanes, not CPU threads. Overlapping durations must not be added.",
    },
  };
}
