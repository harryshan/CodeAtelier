/**
 * 将配置中的协议映射到具体模型客户端，供 Engine 各用途及手动评测入口共用。
 * 1. createModelProvider 接收已经选定的模型配置和对应密钥；缺省保持 Responses。
 * 2. 各分支仅构造客户端，不联网、不重试，不把密钥写入配置或历史。
 * 宿主和 Sandbox Broker 共享工厂，Runtime 本身不持有模型认证信息。
 */
import type { Settings } from "../shared/types.js";
import type { ModelProvider } from "./model-provider.js";
import { ResponsesProvider } from "./responses-provider.js";
import { ChatCompletionsProvider } from "./chat-completions-provider.js";
import { MessagesProvider } from "./messages-provider.js";

export function createModelProvider(
  settings: Settings,
  key: string,
): ModelProvider {
  switch (settings.protocol ?? "responses") {
    case "responses":
      return new ResponsesProvider(settings, key);
    case "chat-completions":
      return new ChatCompletionsProvider(settings, key);
    case "messages":
      return new MessagesProvider(settings, key);
  }
}
