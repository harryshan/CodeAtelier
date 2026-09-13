/**
 * 把 SDK 和网络异常转换为统一的 ModelError，供 ResponsesProvider 和重试逻辑使用。
 *
 * 1. ModelError 保存错误消息、错误码、能否重试，以及可选的 HTTP 状态和请求 ID。
 * 2. modelError 保留已有 ModelError；其他异常按协议错误码、HTTP 状态和连接错误分类。
 *
 * 认证或参数错误不能当作临时故障反复重试。上下文超限必须有明确错误码，不能只根据报错文字猜测。
 */

/** 保存判断重试所需的错误信息，不带出服务端可能含敏感内容的正文。 */
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

export function modelError(error: unknown): ModelError {
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

  // 服务端错误正文可能包含提示词或凭据，不能原样带出。
  return new ModelError(
    status
      ? `模型服务返回 HTTP ${status}。${retryable ? "可尝试重试。" : "请检查密钥、模型、请求参数或服务配置后恢复。"}`
      : retryable
        ? "模型连接异常，可尝试重试。"
        : "模型调用失败，请检查服务配置后恢复。",
    retryable,
    code,
    status,
    retryAfterMs,
    e?.requestID?.slice(0, 128),
  );
}
