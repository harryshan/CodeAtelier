/**
 * 文件作用：把模型及传输异常归一化为可判断重试行为的错误。
 *
 * 模块协作与输入输出：
 * 供 ResponsesProvider 和 retryModel 共用，将 SDK/网络异常转换成稳定错误码与重试判断。
 *
 * 代码结构与执行顺序：
 * 1. ModelError 保存用户可见消息、retryable、code，以及可选 HTTP 状态和请求 ID。
 * 2. modelError 保留已归一化错误，并按明确协议码、HTTP 状态与连接故障进行分类。
 *
 * 关键约束：
 * 不能把任意错误文本猜成上下文溢出；永久参数或认证错误不应进入瞬态重试。
 */

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
  const code =
    e?.code === "context_length_exceeded"
      ? "context_length_exceeded"
      : status
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
