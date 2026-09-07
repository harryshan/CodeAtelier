import OpenAI from "openai";
import type { Settings } from "../shared/types.js";
export interface ModelResult {
  output: any[];
  text: string;
}
export interface ModelProvider {
  run(
    input: any[],
    instructions: string,
    tools: any[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<ModelResult>;
}
export class ResponsesProvider implements ModelProvider {
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
  ): Promise<ModelResult> {
    if (!this.key) throw new Error("请先在设置中输入 API key。");
    const client = new OpenAI({
      baseURL: this.settings.baseUrl,
      apiKey: this.key,
      maxRetries: 0,
      timeout: this.settings.requestTimeoutMs,
    });
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const total = setTimeout(
      () => controller.abort(new Error("模型请求超时")),
      this.settings.requestTimeoutMs,
    );
    let idle: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => controller.abort(new Error("模型流长时间无响应")),
        this.settings.idleTimeoutMs,
      );
    };
    reset();
    let text = "";
    let result: any;
    const items = new Map<number, any>();
    try {
      const stream = await client.responses.create(
        {
          model: this.settings.model,
          input,
          instructions,
          tools,
          stream: true,
          store: false,
        },
        { signal: controller.signal },
      );
      for await (const event of stream) {
        reset();
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          if (text.length > 1000000) {
            controller.abort();
            throw new Error("模型输出超过单次上限。");
          }
          onDelta(event.delta);
        }
        if (event.type === "response.output_item.done")
          items.set(event.output_index, event.item);
        if (event.type === "response.completed") result = event.response;
        if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "error"
        )
          throw new Error("模型响应失败或不完整，请检查模型配置及服务状态。");
      }
      if (!result) throw new Error("模型连接结束但未收到完成事件。");
      const output = result.output?.length
        ? result.output
        : [...items.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, item]) => item);
      const finalText = output
        .filter((i: any) => i.type === "message")
        .flatMap((i: any) => i.content || [])
        .filter((i: any) => i.type === "output_text")
        .map((i: any) => i.text)
        .join("");
      return { output, text: finalText || text };
    } finally {
      clearTimeout(total);
      clearTimeout(idle!);
      signal.removeEventListener("abort", abort);
    }
  }
}
