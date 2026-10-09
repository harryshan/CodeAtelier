/**
 * 为任意 ModelProvider 加上安全的 LLM 调用性能 span，避免 Engine、标题、审批和上下文压缩各自复制计时逻辑。
 * 调用方在发起每种模型用途时创建此包装器；包装器保持原有 ModelProvider 接口和取消语义，
 * 仅把请求/响应的长度、数量、usage、错误类别及首个文本分块时间交给 TraceRecorder。
 *
 * 1. ModelTraceScope 固定任务、用途、模型和可选 step/attempt，作为单次调用的关联字段。
 * 2. tracedModelProvider 透传 capabilities，并在 run 前创建可由当前上下文阶段动态指定父 span 的 llm.request；第一个 delta 生成 instant，完成或失败结束 span。
 * 3. Sandbox Runtime 经 Broker 请求模型时可附 execution mode/instance/kind、subagentId 与 brokered 标记，仍复用相同安全计量。
 * 4. 仅附带安全的请求参数（含思考等级），不记录 input、instructions、tools、输出文本、服务错误消息或 API key 的原文；LLM span 位于 Node 主线程轨道，高保真 replay payload 由后续独立机制处理。
 */

import type { ModelProvider } from "../providers/model-provider.js";
import { TraceRecorder } from "./recorder.js";

export interface ModelTraceScope {
  taskId: string;
  purpose:
    "approval" | "compaction" | "task" | "title" | "subagent" | "tool_review";
  subagentId?: string;
  callId?: string;
  model: string;
  step?: number;
  attempt?: number;
  parentSpanId?: string | (() => string | undefined);
  executionMode?: "host-process" | "windows-sandbox-user";
  executionInstanceId?: string;
  runtimeKind?: "agent-runtime" | "push-runner";
  brokered?: boolean;
}

function serializedLength(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** 返回接口等价的包装器；模型模拟实现也可直接使用，因此不会把 tracing 细节泄漏到 provider 契约。 */
export function tracedModelProvider(
  provider: ModelProvider,
  recorder: TraceRecorder,
  scope: ModelTraceScope,
): ModelProvider {
  return {
    getCapabilities: provider.getCapabilities?.bind(provider),
    async run(input, instructions, tools, signal, onDelta, options) {
      const parentSpanId =
        typeof scope.parentSpanId === "function"
          ? scope.parentSpanId()
          : scope.parentSpanId;
      const span = recorder.startSpan(scope.taskId, {
        name: "llm.request",
        category: "llm",
        track: scope.subagentId
          ? `Subagent ${scope.subagentId} broker`
          : "Main thread",
        parentSpanId,
        attributes: {
          purpose: scope.purpose,
          callId: scope.callId,
          subagentId: scope.subagentId,
          model: scope.model,
          step: scope.step,
          attempt: scope.attempt,
          inputItems: input.length,
          inputChars: serializedLength(input),
          instructionsChars: instructions.length,
          toolCount: tools.length,
          maxOutputTokens: options?.maxOutputTokens,
          reasoningEffort: options?.reasoningEffort,
          executionMode: scope.executionMode,
          executionInstanceId: scope.executionInstanceId,
          runtimeKind: scope.runtimeKind,
          brokered: scope.brokered,
        },
      });
      let receivedFirstDelta = false;

      try {
        const result = await provider.run(
          input,
          instructions,
          tools,
          signal,
          (delta) => {
            if (!receivedFirstDelta) {
              receivedFirstDelta = true;
              recorder.instant(
                scope.taskId,
                "llm.first_output",
                "llm",
                "Main thread",
                {
                  chars: delta.length,
                  purpose: scope.purpose,
                },
              );
            }

            onDelta(delta);
          },
          options,
        );
        recorder.endSpan(span, "ok", {
          outputItems: result.output.length,
          outputChars: result.text.length,
          inputTokens: result.usage?.input_tokens,
          outputTokens: result.usage?.output_tokens,
          totalTokens: result.usage?.total_tokens,
        });

        return result;
      } catch (error: any) {
        recorder.endSpan(span, signal.aborted ? "cancelled" : "error", {
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: typeof error?.code === "string" ? error.code : undefined,
        });
        throw error;
      }
    },
  };
}
