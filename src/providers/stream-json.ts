/**
 * 为 Chat Completions / Messages 提供有界的 JSON SSE 传输，不执行工具或自动重试。
 * 1. streamJson 发起单次 POST，禁用重定向，配置请求/空闲时限并绑定用户取消。
 * 2. 按 SSE 行解析多行 data、注释心跳和 CRLF；完整帧才解析 JSON，保留 [DONE] 终止标记。
 * 3. HTTP/协议异常转为脱敏 ModelError；finally 取消 reader、请求和所有计时器。
 * 密钥只进入请求头；单帧限长防止无限缓冲，完成语义由各 Provider 检查。
 */
import type { Settings } from "../shared/types.js";
import { ModelError, modelError } from "./model-error.js";

export async function* streamJson(
  settings: Settings,
  key: string,
  endpoint: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  onEvent?: () => void,
): AsyncGenerator<any> {
  signal.throwIfAborted();
  if (!key) {
    throw new ModelError("当前模型未配置 API key。", false, "missing_key");
  }

  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const total = setTimeout(
    () =>
      controller.abort(
        new ModelError(
          `模型请求超过 ${settings.requestTimeoutMs} ms 总时限（requestTimeoutMs）。`,
          true,
          "request_timeout",
        ),
      ),
    settings.requestTimeoutMs,
  );
  let idle: ReturnType<typeof setTimeout>;
  const reset = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () =>
        controller.abort(
          new ModelError(
            `模型流连续 ${settings.idleTimeoutMs} ms 未收到事件（idleTimeoutMs）。`,
            true,
            "idle_timeout",
          ),
        ),
      settings.idleTimeoutMs,
    );
  };

  reset();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(
      `${settings.baseUrl.replace(/\/$/, "")}/${endpoint}`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    reader = response.body?.getReader();
    if (!reader) {
      throw new ModelError(
        "模型服务没有返回响应流。",
        true,
        "stream_disconnected",
      );
    }

    if (!response.ok) {
      const decoder = new TextDecoder();
      let text = "";
      while (text.length < 16384) {
        const part = await reader.read();
        if (part.done) {
          break;
        }

        text += decoder.decode(part.value, { stream: true });
      }

      let error: any;
      try {
        error = JSON.parse(text.slice(0, 16384));
      } catch {
        error = { message: "服务未提供有效的 JSON 错误信息。" };
      }

      throw modelError(
        {
          status: response.status,
          headers: response.headers,
          error: error.error ?? error,
          code: error.error?.code,
          requestID:
            response.headers.get("request-id") ??
            response.headers.get("x-request-id"),
        },
        [key],
      );
    }

    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new ModelError("模型服务未返回 SSE。", false, "invalid_stream");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let frameSize = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        frameSize += line.length;
        if (frameSize > 2_000_000) {
          throw new ModelError(
            "模型 SSE 事件超过上限。",
            false,
            "output_limit",
          );
        }

        if (line === "") {
          reset();
          onEvent?.();
          if (data.length) {
            const payload = data.join("\n");
            let event: unknown;
            try {
              event = payload === "[DONE]" ? payload : JSON.parse(payload);
            } catch {
              throw new ModelError(
                "模型 SSE 包含无效 JSON。",
                false,
                "invalid_stream",
              );
            }

            yield event;
          }

          data = [];
          frameSize = 0;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }

      if (buffer.length + frameSize > 2_000_000) {
        throw new ModelError("模型 SSE 事件超过上限。", false, "output_limit");
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (controller.signal.reason instanceof ModelError) {
      throw controller.signal.reason;
    }

    throw modelError(error, [key]);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    clearTimeout(total);
    clearTimeout(idle!);
    signal.removeEventListener("abort", abort);
  }
}
