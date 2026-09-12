/**
 * 文件作用：定义 agent 与具体模型服务之间的通用接口。
 * 代码结构：先声明模型结果，再定义可选能力查询和支持流式文本、取消及输出限制的运行契约。
 */

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
