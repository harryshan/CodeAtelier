/**
 * 定义模型传输协议与本批适配器的能力，供 Config、UI、Engine 和 Runtime 共用。
 * 1. ModelProtocol 保持配置值稳定；未配置时沿用 responses。
 * 2. protocolFeatures 描述已实现的功能，不猜测模型容量或服务商能力。
 * 新协议暂不发送思考参数或原生搜索；工具调用始终由本地引擎执行。
 */
export type ModelProtocol = "responses" | "chat-completions" | "messages";

export function protocolFeatures(protocol: ModelProtocol = "responses") {
  return {
    streaming: true,
    functionTools: true,
    webSearch: protocol === "responses",
    reasoningEffort: protocol === "responses",
  };
}
