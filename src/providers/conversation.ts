/**
 * 在持久化历史与模型 wire 格式之间建立明确的公共对话契约。
 * 1. ConversationItem / ConversationTurn 表达文字、函数调用和函数结果；沿用历史字段名以免改写旧库。
 * 2. conversationTurns 验证历史并合并同一 assistant 回合的多个调用；结果必须成组且按 ID 对应。
 * 3. functionTools 校验工具定义，禁止把服务端内置工具悄悄当成本地函数。
 * 4. parts 保留 Messages 同一回合内文字/工具交错顺序；text/calls 提供 Chat 的独立字段投影。
 * 5. assistantText / functionCall 生成公共记录，完整参数验证后才能交回 Engine。
 * 不丢弃未知协议条目、思考或多模态内容；不能无损转换时明确拒绝，原始历史保持不变。
 */
import { ModelError } from "./model-error.js";

export type ConversationItem =
  | {
      type?: "message";
      role: "user" | "assistant" | "system" | "developer";
      content:
        string | Array<{ type: "input_text" | "output_text"; text: string }>;
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ConversationTurn {
  role: "user" | "assistant" | "system" | "developer" | "tool";
  text: string;
  calls: Array<{ id: string; name: string; arguments: string }>;
  results: Array<{ id: string; text: string }>;
  parts: Array<
    | { type: "text"; text: string }
    | { type: "call"; call: ConversationTurn["calls"][number] }
  >;
}

export function incompatibleHistory(): never {
  throw new ModelError(
    "历史包含无法安全转换的协议内容，请使用原协议续聊或新建会话。",
    false,
    "incompatible_history",
  );
}

export function conversationTurns(input: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Set<string>();
  const used = new Set<string>();
  for (const raw of input) {
    const item = raw as any;
    if (!item || typeof item !== "object") {
      incompatibleHistory();
    }

    if (item.type === "function_call") {
      if (!item.call_id || used.has(item.call_id)) {
        incompatibleHistory();
      }

      functionCall(item.call_id, item.name, item.arguments);
      let turn = turns.at(-1);
      if (turn?.role !== "assistant") {
        if (pending.size) {
          incompatibleHistory();
        }

        turn = {
          role: "assistant",
          text: "",
          calls: [],
          results: [],
          parts: [],
        };
        turns.push(turn);
      }

      const call = {
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };
      turn.calls.push(call);
      turn.parts.push({ type: "call", call });
      pending.add(item.call_id);
      used.add(item.call_id);
    } else if (item.type === "function_call_output") {
      if (!pending.delete(item.call_id) || typeof item.output !== "string") {
        incompatibleHistory();
      }

      let turn = turns.at(-1);
      if (turn?.role !== "tool") {
        turn = { role: "tool", text: "", calls: [], results: [], parts: [] };
        turns.push(turn);
      }

      turn.results.push({ id: item.call_id, text: item.output });
    } else if (
      (!item.type || item.type === "message") &&
      ["user", "assistant", "system", "developer"].includes(item.role)
    ) {
      const previous = turns.at(-1);
      if (
        pending.size &&
        !(item.role === "assistant" && previous?.role === "assistant")
      ) {
        incompatibleHistory();
      }

      let text: string;
      if (typeof item.content === "string") {
        text = item.content;
      } else if (
        Array.isArray(item.content) &&
        item.content.every(
          (part: any) =>
            part &&
            ["input_text", "output_text"].includes(part.type) &&
            typeof part.text === "string",
        )
      ) {
        text = item.content.map((part: any) => part.text).join("");
      } else {
        incompatibleHistory();
      }

      if (item.role === "assistant" && previous?.role === "assistant") {
        previous.text += text;
        if (text) {
          previous.parts.push({ type: "text", text });
        }
      } else {
        turns.push({
          role: item.role,
          text,
          calls: [],
          results: [],
          parts: text ? [{ type: "text", text }] : [],
        });
      }
    } else {
      incompatibleHistory();
    }
  }

  if (pending.size) {
    incompatibleHistory();
  }

  return turns;
}

export function functionTools(tools: any[]) {
  return tools.map((tool) => {
    if (
      tool.type !== "function" ||
      typeof tool.name !== "string" ||
      !tool.parameters
    ) {
      throw new ModelError(
        "当前协议仅支持本地 function tools。",
        false,
        "unsupported_tool",
      );
    }

    return {
      name: tool.name as string,
      description: tool.description as string | undefined,
      parameters: tool.parameters as Record<string, unknown>,
    };
  });
}

export function assistantText(text: string): ConversationItem {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

export function functionCall(
  id: string,
  name: string,
  args: string,
): ConversationItem {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !id ||
      !name ||
      typeof id !== "string" ||
      typeof name !== "string" ||
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error();
    }
  } catch {
    throw new ModelError(
      "模型返回了不完整或无效的工具参数。",
      false,
      "invalid_tool_call",
    );
  }

  return { type: "function_call", call_id: id, name, arguments: args };
}
