/**
 * 定义 Engine 和 ContextManager 调用模型时使用的接口。
 * ResponsesProvider、测试用的模拟模型和评测计量包装都实现这个接口。
 *
 * 1. ModelResult 返回完整协议记录 output、展示文本 text 和可选的实际 usage。
 * 2. ModelProvider.run 接收历史、指令、工具、取消信号和文本回调；getCapabilities 可选提供容量查询。
 * 3. 请求选项中的 maxOutputTokens 用于限制本次输出。
 *
 * 流式回调只负责展示。调用方必须等完整结果返回后再执行工具；历史保存也由调用方负责。
 */

import type { ModelCapabilities, ModelUsage } from "./model-metadata.js";

/** 调用方只依赖这个接口，不需要知道具体服务商。 */
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
