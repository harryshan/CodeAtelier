import type { ModelCapabilities, ModelUsage } from "./model-metadata.js";

/** 不依赖具体服务商的模型调用契约。 */
export interface ModelResult {
  output: any[];
  text: string;
  usage?: ModelUsage;
}

export interface ModelProvider {
  getCapabilities?(signal: AbortSignal): Promise<ModelCapabilities | undefined>;
  run(
    input: any[],
    instructions: string,
    tools: any[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    options?: { maxOutputTokens?: number },
  ): Promise<ModelResult>;
}
