/**
 * 通过 OpenAI SDK 调用已配置的 Responses 服务，实现通用的 ModelProvider 接口。
 * Engine 的主任务和上下文摘要都从这里发送模型请求。
 *
 * 1. getCapabilities 查询模型列表，按完整模型 ID 查找并校验容量信息。
 * 2. run 检查密钥，创建关闭 SDK 重试的客户端，并接上取消、总超时和空闲超时。
 * 3. 请求带上配置思考等级（审批可单次覆盖为 none）、并行工具调用偏好、流式选项和可选输出上限；文本 delta 交给界面，item.done 暂存完整输出项。
 * 4. 收到 completed 后才返回结果。优先使用 completed.output，服务未填时按索引收集 item.done；网页搜索的 URL 引用会转为安全可点击的 Markdown 来源。
 * 5. 将流错误和连接异常转成 ModelError，最后清理计时器和监听。
 *
 * 半截文本和未收齐的工具参数不能算成功响应。重试统一交给上层，避免 SDK 与 Engine 重复重试。
 */

import { capabilitiesSchema, parseUsage } from "./model-metadata.js";
import OpenAI from "openai";
import { ModelError, modelError, modelErrorMessage } from "./model-error.js";
import type { Settings } from "../shared/types.js";
import type {
  ModelProvider,
  ModelResult,
  ModelRunOptions,
} from "./model-provider.js";

/** 仅接受公开 HTTP(S) 引用，并转义标题，避免不可信网页元数据改变 Markdown 结构。 */
function appendWebSearchCitations(text: string, output: any[]) {
  const citations = new Map<string, string>();

  for (const item of output) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (content.type !== "output_text") {
        continue;
      }

      for (const annotation of content.annotations ?? []) {
        if (
          annotation.type !== "url_citation" ||
          typeof annotation.url !== "string"
        ) {
          continue;
        }

        try {
          const url = new URL(annotation.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            continue;
          }

          const title = String(annotation.title ?? url.hostname)
            .replace(/[\\[\\]\\\\]/g, "\\\\$&")
            .replace(/\s+/g, " ")
            .trim();
          if (!citations.has(url.href)) {
            citations.set(url.href, title || url.hostname);
          }
        } catch {
          // 服务返回的引用 URL 也属于不可信数据；格式无效时只忽略该引用。
        }
      }
    }
  }

  if (!text || !citations.size) {
    return text;
  }

  const sources = [...citations].map(
    ([url, title]) => `- [${title}](<${url}>)`,
  );

  return `${text}\n\n### Sources\n${sources.join("\n")}`;
}

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
    options?: ModelRunOptions,
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
          new ModelError(
            `模型请求超过 ${this.settings.requestTimeoutMs} ms 总时限，未收到完成事件（requestTimeoutMs）。`,
            true,
            "request_timeout",
          ),
        ),
      this.settings.requestTimeoutMs,
    );
    let idle: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () =>
          controller.abort(
            new ModelError(
              `模型流连续 ${this.settings.idleTimeoutMs} ms 未收到事件（idleTimeoutMs）。`,
              true,
              "idle_timeout",
            ),
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
          reasoning: {
            effort:
              options?.reasoningEffort ??
              this.settings.reasoningEffort ??
              "high",
          },
          input,
          instructions,
          tools,
          // 允许同一响应携带多个调用；Engine 按显式依赖调度并保留审批和文件校验边界。
          parallel_tool_calls: true,
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
            modelErrorMessage(
              "模型响应失败或不完整，请检查模型配置及服务状态。",
              detail,
              [this.key],
            ),
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
        text: appendWebSearchCitations(finalText, output) || text,
        usage: parseUsage(completedResponse.usage),
      };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }

      if (controller.signal.reason instanceof ModelError) {
        throw controller.signal.reason;
      }

      throw modelError(error, [this.key]);
    } finally {
      clearTimeout(total);
      clearTimeout(idle!);
      signal.removeEventListener("abort", abort);
    }
  }
}
