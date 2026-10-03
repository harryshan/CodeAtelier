/**
 * 声明本机 MCP 网关的模型工具及 Runtime IPC 共用契约，不包含连接地址或凭据。
 * registry 生成严格函数 schema，ToolRunner 和 Broker 再分别校验同一请求。
 *
 * 1. mcpActionSchema 按操作限定字段；发现接口保留服务端分页游标，不自动遍历全部内容。
 * 2. mcpToolSchema 使用 request 包装联合；任意 MCP 参数用 JSON 对象字符串承载，避免改变模型 strict schema。
 * 3. McpResult 标记 Broker 宿主执行与失败/未知状态，供历史、DAG 和 Runtime 使用。
 */
import { z } from "zod";

const server = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const name = z.string().min(1).max(256);
const cursor = z.string().max(4096).nullable();

export const mcpActionSchema = z.union([
  z.object({ action: z.literal("list_servers") }).strict(),
  z.object({ action: z.literal("list_tools"), server, cursor }).strict(),
  z
    .object({
      action: z.literal("call_tool"),
      server,
      name,
      argumentsJson: z.string().max(20000),
    })
    .strict(),
  z.object({ action: z.literal("list_resources"), server, cursor }).strict(),
  z
    .object({ action: z.literal("list_resource_templates"), server, cursor })
    .strict(),
  z
    .object({
      action: z.literal("read_resource"),
      server,
      uri: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ action: z.literal("list_prompts"), server, cursor }).strict(),
  z
    .object({
      action: z.literal("get_prompt"),
      server,
      name,
      argumentsJson: z.string().max(20000),
    })
    .strict(),
]);

export const mcpToolSchema = z.object({ request: mcpActionSchema }).strict();
export type McpAction = z.infer<typeof mcpActionSchema>;

export interface McpResult {
  execution: { kind: "broker-mcp"; mode: "host-process" };
  data?: unknown;
  error?: string;
  outcome?: "unknown";
  truncated?: boolean;
}
