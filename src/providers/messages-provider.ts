/**
 * MessagesProvider 实现 Anthropic Messages 文本及客户端工具调用，不使用提供商托管工具。
 * 1. messagesRequest 将公共回合转换为 system、text、tool_use 和 tool_result；相邻同角色合并。
 * 2. run 依序检查 message/block 生命周期，累积 text 与 JSON 参数，按累计 usage 归一化缓存计数。
 * 3. 所有 block 关闭且 message_stop 正常完成后才返回；未知内容块不丢弃、不执行部分工具。
 * HTTP 认证使用 x-api-key 与固定 anthropic-version；重试、tracing 和历史落盘由上层负责。
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

function messagesRequest(input: unknown[], instructions: string) {
  const system = instructions ? [{ type: "text", text: instructions }] : [];
  const messages: Array<{ role: string; content: any[] }> = [];
  for (const turn of conversationTurns(input)) {
    if (turn.role === "system" || turn.role === "developer") {
      system.push({ type: "text", text: turn.text });
      continue;
    }

    const role = turn.role === "assistant" ? "assistant" : "user";
    const content: any[] = turn.parts.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : {
            type: "tool_use",
            id: part.call.id,
            name: part.call.name,
            input: JSON.parse(part.call.arguments),
          },
    );
    content.push(
      ...turn.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.id,
        content: result.text,
      })),
    );
    if (!content.length) {
      throw new ModelError(
        "Messages 不接受空消息。",
        false,
        "incompatible_history",
      );
    }

    const previous = messages.at(-1);
    if (previous?.role === role) {
      previous.content.push(...content);
    } else {
      messages.push({ role, content });
    }
  }

  return { system, messages };
}

export class MessagesProvider implements ModelProvider {
  readonly protocol = "messages" as const;

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
      ...messagesRequest(input, instructions),
      max_tokens:
        options?.maxOutputTokens ?? this.settings.maxOutputTokens ?? 16384,
      stream: true,
      ...(functions.length
        ? {
            tools: functions.map(({ parameters, ...tool }) => ({
              ...tool,
              input_schema: parameters,
            })),
          }
        : {}),
    };
    const blocks = new Map<
      number,
      {
        type: "text" | "tool_use";
        text: string;
        id: string;
        name: string;
        args: string;
        closed: boolean;
      }
    >();
    let started = false;
    let done = false;
    let stop: string | undefined;
    let text = "";
    let size = 0;
    let usage: any;
    let finalOutputTokens: unknown;

    function invalid(): never {
      throw new ModelError(
        "Messages 流的消息或内容块顺序无效。",
        false,
        "invalid_stream",
      );
    }

    for await (const event of streamJson(
      this.settings,
      this.key,
      "messages",
      { "x-api-key": this.key, "anthropic-version": "2023-06-01" },
      body,
      signal,
      options?.onStreamEvent,
    )) {
      if (event?.type === "ping") {
        continue;
      }

      if (event?.type === "error") {
        const status =
          event.error?.type === "overloaded_error"
            ? 529
            : event.error?.type === "rate_limit_error"
              ? 429
              : event.error?.type === "api_error"
                ? 500
                : undefined;
        throw modelError({ ...event, status }, [this.key]);
      }

      if (event?.type === "message_start") {
        if (
          started ||
          event.message?.role !== "assistant" ||
          !Array.isArray(event.message.content) ||
          event.message.content.length !== 0
        ) {
          invalid();
        }

        started = true;
        usage = event.message.usage;
      } else if (!started) {
        invalid();
      } else if (event.type === "content_block_start") {
        if (
          stop ||
          !Number.isInteger(event.index) ||
          event.index < 0 ||
          blocks.has(event.index)
        ) {
          invalid();
        }

        const block = event.content_block;
        if (!["text", "tool_use"].includes(block?.type)) {
          throw new ModelError(
            "当前 Messages 适配器不支持该内容块（思考、多模态或服务端工具）。",
            false,
            "unsupported_response",
          );
        }

        // 流式 tool_use 的起始 input 必须为空对象，参数仅来自后续 JSON delta。
        // 不忽略非标准的初始参数，避免误把缺失参数当作可执行的 {}。
        if (
          block.type === "tool_use" &&
          (!block.input ||
            typeof block.input !== "object" ||
            Array.isArray(block.input) ||
            Object.keys(block.input).length !== 0)
        ) {
          invalid();
        }

        const initial = block.type === "text" ? block.text : "";
        if (typeof initial !== "string") {
          invalid();
        }

        blocks.set(event.index, {
          type: block.type,
          text: initial,
          id: block.id ?? "",
          name: block.name ?? "",
          args: "",
          closed: false,
        });
        if (initial) {
          text += initial;
          onDelta(initial);
        }

        size += initial.length;
      } else if (event.type === "content_block_delta") {
        const block = blocks.get(event.index);
        if (!block || block.closed || stop) {
          invalid();
        }

        const delta = event.delta;
        if (
          block.type === "text" &&
          delta?.type === "text_delta" &&
          typeof delta.text === "string"
        ) {
          block.text += delta.text;
          text += delta.text;
          size += delta.text.length;
          onDelta(delta.text);
        } else if (
          block.type === "tool_use" &&
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          block.args += delta.partial_json;
          size += delta.partial_json.length;
        } else {
          invalid();
        }
      } else if (event.type === "content_block_stop") {
        const block = blocks.get(event.index);
        if (!block || block.closed || stop) {
          invalid();
        }

        block.closed = true;
      } else if (event.type === "message_delta") {
        if (stop || [...blocks.values()].some((block) => !block.closed)) {
          invalid();
        }

        stop = event.delta?.stop_reason;
        usage = { ...usage, ...event.usage };
        finalOutputTokens = event.usage?.output_tokens;
      } else if (event.type === "message_stop") {
        done = true;
        break;
      } else {
        invalid();
      }

      if (size > 1_000_000 || blocks.size > 256) {
        throw new ModelError("模型输出超过单次上限。", false, "output_limit");
      }
    }

    signal.throwIfAborted();
    if (!done || !stop || [...blocks.values()].some((block) => !block.closed)) {
      throw new ModelError(
        "模型连接结束但未收到完整完成事件。",
        true,
        "stream_disconnected",
      );
    }

    const hasTools = [...blocks.values()].some(
      (block) => block.type === "tool_use",
    );
    if (
      !["end_turn", "stop_sequence", "tool_use"].includes(stop) ||
      hasTools !== (stop === "tool_use")
    ) {
      throw new ModelError(
        "模型响应被截断、拒绝或工具完成状态不一致。",
        false,
        stop === "max_tokens" ? "max_output_tokens" : "response_failed",
      );
    }

    const output: ConversationItem[] = [];
    const ids = new Set<string>();
    for (const [, block] of [...blocks].sort(([a], [b]) => a - b)) {
      if (block.type === "text") {
        if (block.text) {
          output.push(assistantText(block.text));
        }
      } else {
        if (ids.has(block.id)) {
          invalid();
        }

        ids.add(block.id);
        output.push(functionCall(block.id, block.name, block.args || "{}"));
      }
    }

    if (!output.length) {
      throw new ModelError("模型返回空响应。", true, "empty_response");
    }

    const cached =
      usage?.cache_read_input_tokens === undefined
        ? 0
        : usage.cache_read_input_tokens;
    const created =
      usage?.cache_creation_input_tokens === undefined
        ? 0
        : usage.cache_creation_input_tokens;
    // 初始 output_tokens 只是流起点，缺失最终累计计数时必须保持未知；
    // 每个原始计数都要合法，不能让负缓存值经求和变成看似正常的输入数。
    const validUsage = [
      usage?.input_tokens,
      finalOutputTokens,
      cached,
      created,
    ].every((value) => Number.isSafeInteger(value) && value >= 0);
    const inputTokens = usage?.input_tokens + cached + created;

    return {
      output,
      text,
      usage: validUsage
        ? parseUsage({
            input_tokens: inputTokens,
            output_tokens: finalOutputTokens,
            total_tokens: inputTokens + Number(finalOutputTokens),
            input_tokens_details: { cached_tokens: cached },
          })
        : undefined,
    };
  }
}
