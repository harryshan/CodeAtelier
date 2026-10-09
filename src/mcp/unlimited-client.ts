/**
 * 为固定版本 MCP SDK 1.31.0 补充真正无请求定时器的模式，供 McpTaskClient 使用。
 * 1. createMcpClient 创建官方 Client，保留其协议、响应、取消及 progress 实现。
 * 2. SDK 没有禁用 timeout 的公开选项：0/Infinity 都会被 Node 当作极短定时器。
 *    仅在本地 timeout=0 时跳过内部 _setupTimeout，有限握手超时仍调用原方法。
 * 3. 不使用巨大期限或重置心跳，不修改 node_modules；升级 SDK 时必须重新验证此兼容点。
 * 接口不存在即明确失败；生命周期、权限和取消继续由 McpTaskClient 管理。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export function createMcpClient() {
  const client = new Client(
    { name: "CodeAtelier", version: "0.1.0" },
    { capabilities: {} },
  );
  const setupTimeout = Reflect.get(client, "_setupTimeout") as unknown;
  if (typeof setupTimeout !== "function") {
    throw new Error("MCP SDK timeout adapter 不兼容，须更新并验证适配器。");
  }

  Object.defineProperty(client, "_setupTimeout", {
    value: (messageId: number, timeout: number, ...rest: unknown[]) => {
      if (timeout !== 0) {
        Reflect.apply(setupTimeout, client, [messageId, timeout, ...rest]);
      }
    },
  });

  return client;
}
