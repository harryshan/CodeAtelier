/**
 * 通过 OpenAI SDK 调用已配置的 Responses 服务，实现通用的 ModelProvider 接口。
 * Engine 的主任务和上下文摘要都从这里发送模型请求。
 *
 * 1. getCapabilities 查询模型列表，按完整模型 ID 查找并校验容量信息。
 * 2. run 检查密钥，创建关闭 SDK 重试的客户端，并接上取消、总超时和空闲超时。
 * 3. 请求带上思考等级、流式选项和可选输出上限；文本 delta 交给界面，item.done 暂存完整输出项。
 * 4. 收到 completed 后才返回结果。优先使用 completed.output，服务未填时按索引收集 item.done。
 * 5. 将流错误和连接异常转成 ModelError，最后清理计时器和监听。
 *
 * 半截文本和未收齐的工具参数不能算成功响应。重试统一交给上层，避免 SDK 与 Engine 重复重试。
 */

import { capabilitiesSchema, parseUsage } from "./model-metadata.js";
import OpenAI from "openai";
import { ModelError, modelError } from "./model-error.js";
import type { Settings } from "../shared/types.js";
import type { ModelProvider, ModelResult } from "./model-provider.js";

export class ResponsesProvider implements ModelProvider {
  constructor(
    private settings: Settings,
    private key: string,
  ) {}

  async getCapabilities(signal: AbortSignal) {
    const client = new OpenAI({
      baseURL: this.settings.baseUrl,
      apiKey: this.key,
      maxRetries: 0,
      timeout: Math.min(10000, this.settings.requestTimeoutMs),
    });
    const models = await client.models.list({ signal });
    const model = models.data.find((entry) => entry.id === this.settings.model);
    const parsed = capabilitiesSchema.safeParse((model as any)?.capabilities);

    return parsed.success ? parsed.data : undefined;
  }

  async run(
    input: any[],
    instructions: string,
    tools: any[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    options?: { maxOutputTokens?: number },
  ): Promise<ModelResult> {
    if (!this.key) {
      throw new ModelError("请先在设置中输入 API key。", false, "missing_key");
    }

    const client = new OpenAI({
      baseURL: this.settings.baseUrl,
      apiKey: this.key,
      maxRetries: 0,
      timeout: this.settings.requestTimeoutMs,
    });
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }

    const total = setTimeout(
      () =>
        controller.abort(
          new ModelError("模型请求超时", true, "request_timeout"),
        ),
      this.settings.requestTimeoutMs,
    );
    let idle: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () =>
          controller.abort(
            new ModelError("模型流长时间无响应", true, "idle_timeout"),
          ),
        this.settings.idleTimeoutMs,
      );
    };

    reset();
    let text = "";
    let completedResponse: any;
    // 有些服务的 completed.output 为空，先暂存 item.done，收到完成事件后再组装结果。
    const completedItemsByIndex = new Map<number, any>();

    try {
      const stream = await client.responses.create(
        {
          model: this.settings.model,
          reasoning: { effort: this.settings.reasoningEffort ?? "high" },
          input,
          instructions,
          tools,
          stream: true,
          store: false,
          ...(options?.maxOutputTokens
            ? { max_output_tokens: options.maxOutputTokens }
            : {}),
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        reset();
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          if (text.length > 1000000) {
            controller.abort();
            throw new ModelError(
              "模型输出超过单次上限。",
              false,
              "output_limit",
            );
          }

          onDelta(event.delta);
        }

        if (event.type === "response.output_item.done") {
          completedItemsByIndex.set(event.output_index, event.item);
        }

        if (event.type === "response.completed") {
          completedResponse = event.response;
          break;
        }

        if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "error"
        ) {
          const detail = event as any;
          const code =
            detail.response?.error?.code ||
            detail.error?.code ||
            detail.code ||
            detail.response?.incomplete_details?.reason ||
            "stream_failed";
          const retryable = [
            "server_error",
            "rate_limit_exceeded",
            "stream_failed",
          ].includes(code);

          throw new ModelError(
            "模型响应失败或不完整，请检查模型配置及服务状态。",
            retryable,
            [
              "server_error",
              "rate_limit_exceeded",
              "stream_failed",
              "max_output_tokens",
              "content_filter",
              "context_length_exceeded",
            ].includes(code)
              ? code
              : "response_failed",
          );
        }
      }

      if (!completedResponse) {
        throw new ModelError(
          "模型连接结束但未收到完成事件。",
          true,
          "stream_disconnected",
        );
      }

      const output = completedResponse.output?.length
        ? completedResponse.output
        : [...completedItemsByIndex.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, item]) => item);
      const finalText = output
        .filter((i: any) => i.type === "message")
        .flatMap((i: any) => i.content || [])
        .filter((i: any) => i.type === "output_text")
        .map((i: any) => i.text)
        .join("");

      if (!output.length && !text) {
        throw new ModelError(
          "模型返回空响应，可尝试重试。",
          true,
          "empty_response",
        );
      }

      return {
        output,
        text: finalText || text,
        usage: parseUsage(completedResponse.usage),
      };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }

      if (controller.signal.reason instanceof ModelError) {
        throw controller.signal.reason;
      }

      throw modelError(error);
    } finally {
      clearTimeout(total);
      clearTimeout(idle!);
      signal.removeEventListener("abort", abort);
    }
  }
}
