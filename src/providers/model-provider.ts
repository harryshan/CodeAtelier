/** 不依赖具体服务商的模型调用契约。 */
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
