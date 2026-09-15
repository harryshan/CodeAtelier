/**
 * 把 SDK 和网络异常转换为统一的 ModelError，供 ResponsesProvider 和重试逻辑使用。
 *
 * 1. ModelError 保存供界面、历史和重试使用的错误消息、错误码、能否重试，以及可选的 HTTP 状态和请求 ID。
 * 2. modelErrorDetail 从 SDK 异常或 Responses 错误事件提取服务实际给出的 message/reason/code，并对凭据脱敏、限长。
 * 3. modelError 保留已有 ModelError；其他异常按协议错误码、HTTP 状态和连接错误分类，并将实际错误细节附在可恢复建议后。
 *
 * 认证或参数错误不能当作临时故障反复重试。上下文超限必须有明确错误码，不能只根据报错文字猜测；
 * 这里不保存任意响应正文，只保存服务明确标为错误消息或原因的受控字段。
 */

import { redactText } from "../logging/redact.js";

const MAX_ERROR_DETAIL_LENGTH = 1200;

/** 保存判断重试和向用户报告所需的错误信息。 */
export class ModelError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public code: string,
    public status?: number,
    public retryAfterMs?: number,
    public requestId?: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/**
 * 只读取模型协议约定的错误字段，按优先级保留最接近服务端原始错误的文字。
 * 不能 stringify 整个异常或响应对象：它们可能包含请求输入、响应内容或认证数据。
 */
export function modelErrorDetail(
  error: unknown,
  secrets: string[] = [],
): string | undefined {
  const read = (path: string[]) => {
    let value = error;

    for (const key of path) {
      if (!value || typeof value !== "object") {
        return undefined;
      }

      value = Reflect.get(value, key);
    }

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  for (const path of [
    ["response", "error", "message"],
    ["error", "message"],
    ["message"],
    ["response", "incomplete_details", "reason"],
    ["response", "error", "code"],
    ["error", "code"],
    ["code"],
  ]) {
    const detail = read(path);

    if (detail) {
      const clean = redactText(detail, secrets);

      return clean.length > MAX_ERROR_DETAIL_LENGTH
        ? clean.slice(0, MAX_ERROR_DETAIL_LENGTH) + "…（错误信息已截断）"
        : clean;
    }
  }

  return undefined;
}

/** 将实际错误细节附到面向用户的概述；服务未给出文字时明确说明，避免伪造原因。 */
export function modelErrorMessage(
  summary: string,
  error: unknown,
  secrets: string[] = [],
): string {
  return `${summary} 实际错误：${modelErrorDetail(error, secrets) ?? "服务未提供详细错误信息。"}`;
}

export function modelError(error: unknown, secrets: string[] = []): ModelError {
  if (error instanceof ModelError) {
    return error;
  }

  const e = error as {
    status?: number;
    name?: string;
    headers?: Headers;
    requestID?: string;
    code?: string;
  } | null;
  const status = e?.status;
  const retryable =
    status !== undefined
      ? [408, 409, 429].includes(status) || status >= 500
      : [
          "APIConnectionError",
          "APIConnectionTimeoutError",
          "TypeError",
        ].includes(e?.name || "");
  const header = e?.headers?.get("retry-after");
  const retryAfterMs = header
    ? Number.isFinite(Number(header))
      ? Number(header) * 1000
      : Date.parse(header) - Date.now()
    : undefined;
  const code =
    e?.code === "context_length_exceeded"
      ? "context_length_exceeded"
      : status
        ? `http_${status}`
        : retryable
          ? "connection"
          : "model_error";
  const summary = status
    ? `模型服务返回 HTTP ${status}。${retryable ? "可尝试重试。" : "请检查密钥、模型、请求参数或服务配置后恢复。"}`
    : retryable
      ? "模型连接异常，可尝试重试。"
      : "模型调用失败，请检查服务配置后恢复。";

  return new ModelError(
    modelErrorMessage(summary, error, secrets),
    retryable,
    code,
    status,
    retryAfterMs,
    e?.requestID?.slice(0, 128),
  );
}
