/**
 * 为 IPC 跨进程回归和手动 MXC 验证提供同一确定性 Broker fixture，不调用真实模型、数据库或宿主命令。
 * 1. createRuntimeProbe 绑定启动器持有的 streams/identity/nonce，使用生产 RuntimeIpcBrokerSession 和 RuntimeBrokerGateway。
 * 2. 模型首轮生成固定工具 DAG，次轮收集回传结果；blocked 模式等待取消，用于断连/取消观测。
 * 3. session handler 仅维护 fixture 内存账本，额外宿主能力一律拒绝；实际文件工具运行在 Runtime。
 * 4. traceSpan 将真实 Runtime 安全事件组装进 TraceRecorder，保留任务/关联 ID，不记录正文或 nonce。
 * fixture 不能替代产品 Store 持久化、平台身份认证或 launcher 进程树清理验收。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { RuntimeBrokerGateway } from "../../src/sandbox/runtime-capability-core.js";
import { RuntimeIpcBrokerSession } from "../../src/sandbox/runtime-ipc-broker-session.js";
import type { RuntimeIpcTransport } from "../../src/sandbox/runtime-ipc-peer.js";
import { encodeRuntimeStartupDescriptor } from "../../src/sandbox/runtime-startup-protocol.js";
import { TraceRecorder } from "../../src/tracing/recorder.js";
import type { TraceSpan } from "../../src/tracing/types.js";

export function createRuntimeProbe(
  transport: RuntimeIpcTransport,
  options: {
    workspace: string;
    calls?: Array<{ name: string; arguments: unknown }>;
    blocked?: boolean;
  },
) {
  const identity = {
    sessionId: randomUUID(),
    taskId: randomUUID(),
    executionInstanceId: randomUUID(),
    kind: "agent-runtime" as const,
  };
  const nonce = randomBytes(32).toString("hex");
  const descriptor = { protocolVersion: 1 as const, identity, nonce };
  const traces = new TraceRecorder();
  traces.startTask(identity.taskId, identity.sessionId);
  const remoteSpans = new Map<string, TraceSpan | undefined>();
  const state = {
    modelCalls: 0,
    modelAborted: false,
    context: [] as unknown[],
    modelInputs: [] as unknown[][],
    events: [] as Array<{ type: string; data: unknown }>,
    completion: undefined as { status: string; failure?: string } | undefined,
  };
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  const deny = async (): Promise<never> => {
    throw new Error("Fixture host capability denied");
  };

  const gateway = new RuntimeBrokerGateway(
    {
      authorize: (candidate) => candidate === identity,
      approveCommand: async () => ({ approved: false }),
      modelProvider: () => ({
        model: "ipc-fixture",
        provider: {
          async run(input, _instructions, _tools, signal, onDelta) {
            state.modelCalls += 1;
            state.modelInputs.push(structuredClone(input));
            modelStarted();
            if (options.blocked) {
              await new Promise<never>((_resolve, reject) => {
                const abort = () => {
                  state.modelAborted = true;
                  reject(signal.reason);
                };

                if (signal.aborted) {
                  abort();
                } else {
                  signal.addEventListener("abort", abort, { once: true });
                }
              });
            }

            if (state.modelCalls === 1 && options.calls?.length) {
              return {
                text: "",
                output: options.calls.map((call, index) => ({
                  type: "function_call",
                  call_id: `call-${index}`,
                  name: call.name,
                  arguments: JSON.stringify({
                    execution: { id: `node-${index}`, dependsOn: [] },
                    arguments: call.arguments,
                  }),
                })),
              };
            }

            onDelta?.("IPC fixture complete");

            return {
              text: "IPC fixture complete",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "IPC fixture complete" },
                  ],
                },
              ],
            };
          },
        },
      }),
    },
    traces,
  );
  const broker = new RuntimeIpcBrokerSession(
    transport,
    identity,
    nonce,
    gateway,
    {
      requestApproval: async () => ({ approved: false }),
      executeGitPush: deny,
      prepareCapabilityCommand: deny,
      applyMemory: deny,
      appendSessionEvent: async (_identity, type, data) => {
        state.events.push({ type, data });
      },
      saveContext: async (_identity, input) => {
        state.context = structuredClone(input);
      },
      readContext: async () => structuredClone(state.context),
      readEvents: async () => [],
      latestContextSnapshot: async () => undefined,
      readContextSnapshot: async () => undefined,
      compactContext: deny,
      runtimeCompleted: async (_identity, result) => {
        state.completion = result;
      },
      traceSpan: (event) => {
        if (event.event === "trace_span_start") {
          remoteSpans.set(
            event.spanId,
            traces.startSpan(identity.taskId, {
              name: event.name,
              category: "runtime",
              track: "Runtime IPC fixture",
              startedAtUs: event.timestampUs,
              attributes: event.attributes,
            }),
          );
        } else {
          traces.endSpan(
            remoteSpans.get(event.spanId),
            event.status,
            event.attributes,
            event.timestampUs,
          );
        }
      },
    },
  );

  return {
    broker,
    state,
    started,
    traces,
    identity,
    sendDescriptor(wrongNonce = false) {
      transport.output.write(
        encodeRuntimeStartupDescriptor({
          ...descriptor,
          nonce: wrongNonce ? "0".repeat(64) : nonce,
        }),
      );
    },
    start(signal: AbortSignal) {
      return broker.startTask(
        {
          workspace: options.workspace,
          prompt: "Run the fixed IPC fixture tools.",
          settings: {
            model: "ipc-fixture",
            maxSteps: 4,
            commandTimeoutMs: 0,
            maxOutputTokens: 1024,
            maxContextTokens: 64000,
            contextChars: 64000,
            outputChars: 16000,
          },
        },
        signal,
      );
    },
  };
}
