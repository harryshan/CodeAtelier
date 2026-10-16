/**
 * ChatCompletionsProvider 将公共历史映射为 messages，通过共享 SSE 传输调用 chat/completions。
 * 1. chatMessages 合并同轮 assistant 工具调用，保持 tool_call_id 与结果的对应关系。
 * 2. run 累积文字与按 index 分片的函数参数，归一化 usage；不发送 Responses 专属参数。
 * 3. 只有合法 finish_reason 且收到 [DONE] 才返回公共记录；截断、拒绝和半截参数均不执行。
 * 不内置重试、搜索或推理扩展；模型请求 tracing 由调用方统一包装，首事件由 onStreamEvent 上报。
 */
import type { Settings } from "../shared/types.js";
import type { ModelProvider, ModelRunOptions } from "./model-provider.js";
import {
  assistantText,
  conversationTurns,
  functionCall,
  functionTools,
  type ConversationItem,
} from "./conversation.js";
import { ModelError, modelError } from "./model-error.js";
import { parseUsage } from "./model-metadata.js";
import { streamJson } from "./stream-json.js";

function chatMessages(input: unknown[], instructions: string) {
  const messages: any[] = instructions
    ? [{ role: "system", content: instructions }]
    : [];
  for (const turn of conversationTurns(input)) {
    if (turn.role === "tool") {
      messages.push(
        ...turn.results.map((result) => ({
          role: "tool",
          tool_call_id: result.id,
          content: result.text,
        })),
      );
    } else {
      messages.push({
        role: turn.role,
        content: turn.text || (turn.calls.length ? null : ""),
        ...(turn.calls.length
          ? {
              tool_calls: turn.calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
    }
  }

  return messages;
}

export class ChatCompletionsProvider implements ModelProvider {
  readonly protocol = "chat-completions" as const;

  constructor(
    private settings: Settings,
    private key: string,
  ) {}

  async run(
    input: any[],
    instructions: string,
    tools: any[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    options?: ModelRunOptions,
  ) {
    const functions = functionTools(tools);
    const body = {
      model: this.settings.model,
      messages: chatMessages(input, instructions),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens:
        options?.maxOutputTokens ?? this.settings.maxOutputTokens ?? 16384,
      ...(functions.length
        ? {
            tools: functions.map((tool) => ({
              type: "function",
              function: tool,
            })),
          }
        : {}),
    };
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let text = "";
    let size = 0;
    let finish: string | undefined;
    let done = false;
    let usage;
    for await (const event of streamJson(
      this.settings,
      this.key,
      "chat/completions",
      { authorization: `Bearer ${this.key}` },
      body,
      signal,
      options?.onStreamEvent,
    )) {
      if (event === "[DONE]") {
        done = true;
        break;
      }

      if (event?.error) {
        throw modelError(event, [this.key]);
      }

      if (event?.usage) {
        usage = parseUsage({
          input_tokens: event.usage.prompt_tokens,
          output_tokens: event.usage.completion_tokens,
          total_tokens: event.usage.total_tokens,
          input_tokens_details: event.usage.prompt_tokens_details,
          output_tokens_details: event.usage.completion_tokens_details,
        });
      }

      for (const choice of event?.choices ?? []) {
        if (choice.index !== 0 || finish) {
          throw new ModelError(
            "模型返回了非预期的候选或完成后内容。",
            false,
            "invalid_stream",
          );
        }

        const delta = choice.delta ?? {};
        if (delta.refusal || delta.reasoning_content || delta.function_call) {
          throw new ModelError(
            "当前 Chat Completions 适配器不支持该响应扩展或拒绝内容。",
            false,
            "unsupported_response",
          );
        }

        if (typeof delta.content === "string") {
          text += delta.content;
          size += delta.content.length;
          onDelta(delta.content);
        }

        for (const part of delta.tool_calls ?? []) {
          if (
            !Number.isInteger(part.index) ||
            part.index < 0 ||
            (part.type && part.type !== "function")
          ) {
            throw new ModelError(
              "模型返回无效的工具分片。",
              false,
              "invalid_tool_call",
            );
          }

          const call = calls.get(part.index) ?? { id: "", name: "", args: "" };
          call.id += part.id ?? "";
          call.name += part.function?.name ?? "";
          call.args += part.function?.arguments ?? "";
          size +=
            (part.id?.length ?? 0) +
            (part.function?.name?.length ?? 0) +
            (part.function?.arguments?.length ?? 0);
          calls.set(part.index, call);
        }

        if (choice.finish_reason) {
          finish = choice.finish_reason;
        }
      }

      if (size > 1_000_000 || calls.size > 128) {
        throw new ModelError("模型输出超过单次上限。", false, "output_limit");
      }
    }

    signal.throwIfAborted();
    if (!done || !finish) {
      throw new ModelError(
        "模型连接结束但未收到完整完成事件。",
        true,
        "stream_disconnected",
      );
    }

    if (
      !["stop", "tool_calls"].includes(finish) ||
      calls.size > 0 !== (finish === "tool_calls")
    ) {
      throw new ModelError(
        "模型响应被截断、过滤或工具完成状态不一致。",
        false,
        finish === "length" ? "max_output_tokens" : "response_failed",
      );
    }

    const output: ConversationItem[] = text ? [assistantText(text)] : [];
    const ids = new Set<string>();
    for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
      if (ids.has(call.id)) {
        throw new ModelError(
          "模型返回重复工具 ID。",
          false,
          "invalid_tool_call",
        );
      }

      ids.add(call.id);
      output.push(functionCall(call.id, call.name, call.args));
    }

    if (!output.length) {
      throw new ModelError("模型返回空响应。", true, "empty_response");
    }

    return { output, text, usage };
  }
}
