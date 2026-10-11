/**
 * 以任务和实际 callId 建立模型、工具 DAG 与持久化的因果关系，供模型包装器和 Engine 调用。
 * 1. modelStarted/modelFinished 只读取协议条目的类型与 call_id，不解析参数或猜测最近模型请求。
 * 2. event 接收已验证工具图与状态，记录依赖等待、准备、槽位排队；Runtime 状态为 Broker 观察时间。
 * 3. toolStarted/persistStarted 在真实业务边界绑定 span，成功依赖及下一轮模型由固定 ID 连接。
 * 4. 每任务最多保留 10000 个调用关联，超限显式标记；discard 随任务收尾释放全部索引。
 */
import type { TraceRecorder } from "./recorder.js";
import type { TraceSpan } from "./types.js";

interface Call {
  model?: TraceSpan;
  tool?: TraceSpan;
  persisted?: TraceSpan;
  consumed?: boolean;
  dependencies?: string[];
  phase?: TraceSpan;
  state?: string;
}

export class TraceRelations {
  private tasks = new Map<string, Map<string, Call>>();
  private overflow = new Set<string>();
  constructor(private recorder: TraceRecorder) {}

  private calls(taskId: string) {
    let calls = this.tasks.get(taskId);
    if (!calls) {
      calls = new Map();
      this.tasks.set(taskId, calls);
    }

    return calls;
  }

  private call(taskId: string, id: unknown) {
    if (typeof id !== "string" || id.length > 200) {
      return undefined;
    }

    const calls = this.calls(taskId);
    if (!calls.has(id)) {
      if (calls.size >= 10000) {
        if (!this.overflow.has(taskId)) {
          this.overflow.add(taskId);
          this.recorder.instant(
            taskId,
            "tracing.relations_overflow",
            "tracing",
            "Task",
            { maxCalls: 10000 },
          );
        }

        return undefined;
      }

      calls.set(id, {});
    }

    return calls.get(id)!;
  }

  modelStarted(span: TraceSpan | undefined, input: any[]) {
    if (!span) {
      return;
    }

    for (const item of input) {
      if (item?.type !== "function_call_output") {
        continue;
      }

      const call = this.tasks.get(span.taskId)?.get(item.call_id);
      if (call?.persisted && !call.consumed) {
        this.recorder.link(call.persisted, span, "result_to_model");
        call.consumed = true;
      }
    }
  }

  modelFinished(span: TraceSpan | undefined, output: any[]) {
    if (!span) {
      return;
    }

    for (const item of output) {
      if (item?.type === "function_call") {
        const call = this.call(span.taskId, item.call_id);
        if (call) {
          call.model = span;
        }
      }
    }
  }

  toolStarted(span: TraceSpan | undefined) {
    if (!span) {
      return;
    }

    const call = this.call(span.taskId, span.attributes.callId);
    if (!call) {
      return;
    }

    call.tool = span;
    this.recorder.link(call.model, span, "llm_to_tool");
    for (const id of call.dependencies ?? []) {
      const dependency = this.tasks.get(span.taskId)?.get(id)?.tool;
      if (dependency?.status === "ok") {
        this.recorder.link(dependency, span, "tool_dependency");
      }
    }
  }

  persistStarted(span: TraceSpan | undefined) {
    if (!span) {
      return;
    }

    const call = this.call(span.taskId, span.attributes.callId);
    if (call) {
      call.persisted = span;
      this.recorder.link(call.tool, span, "tool_to_result");
    }
  }

  event(taskId: string, type: string, data: any, observed = false) {
    if (type === "tool_batch_planned" && Array.isArray(data.nodes)) {
      const byNode = new Map(
        data.nodes.map((node: any) => [node.nodeId, node.callId]),
      );
      for (const node of data.nodes) {
        const call = this.call(taskId, node.callId);
        if (call) {
          call.dependencies = (node.dependsOn ?? [])
            .map((id: string) => byNode.get(id))
            .filter((id: unknown): id is string => typeof id === "string");
        }
      }
    } else if (type === "tool_state") {
      const call = this.call(taskId, data.callId);
      if (!call || call.state === data.state) {
        return;
      }

      this.recorder.endSpan(
        call.phase,
        data.state === "failed" ? "error" : "ok",
        { nextState: data.state },
      );
      call.phase = undefined;
      call.state = data.state;
      const names: Record<string, string> = {
        waiting_dependencies: "tool.dependency_wait",
        preparing: "tool.prepare",
        queued: "tool.slot_wait",
      };
      if (names[data.state]) {
        call.phase = this.recorder.startSpan(taskId, {
          name: names[data.state],
          category: "scheduler",
          track: "Tool scheduler",
          attributes: {
            callId: data.callId,
            batchId: data.batchId,
            nodeId: data.nodeId,
            clock: observed ? "broker-observed" : "local",
          },
        });
      }
    }
  }

  discard(taskId: string) {
    this.tasks.delete(taskId);
    this.overflow.delete(taskId);
  }
}
