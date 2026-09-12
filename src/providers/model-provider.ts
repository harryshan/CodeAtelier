/**
 * 文件作用：定义 agent 与具体模型服务之间的通用接口。
 *
 * 模块协作与输入输出：
 * 作为 Engine/ContextManager 与 ResponsesProvider、测试替身、MeteredProvider 之间的依赖边界。
 *
 * 代码结构与执行顺序：
 * 1. ModelResult 携带完整协议 output、展示 text 和可选实际 usage。
 * 2. ModelProvider 的可选 getCapabilities 负责公开容量查询，run 接收历史、规则、工具、取消信号和文本回调。
 * 3. 可选请求参数传递 maxOutputTokens，便于具体服务适配。
 *
 * 关键约束：
 * 流式文本回调仅供展示；工具调度必须等待完整结果，本接口不承担执行工具或持久化历史。
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
