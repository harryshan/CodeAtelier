/** 模型错误分类，保留重试决策所需信息，不传播服务端敏感正文。 */
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
  const code = status
    ? `http_${status}`
    : retryable
      ? "connection"
      : "model_error";

  // Never copy arbitrary server bodies (which can contain prompts or credentials).
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
