/**
 * 读取仅由本机后端 Config 持有的 MCP 配置；不从任务工作区自动发现配置，也不向 UI/Runtime 暴露凭据。
 *
 * 1. mcpServerSchema 限定 stdio 命令/环境或 Streamable HTTP 地址/请求头，并限制超时与配置大小。
 * 2. loadMcpServers 在启动时读取数据目录 mcp.json，或显式绝对路径；默认文件缺失表示关闭，损坏配置则拒绝启动。
 * 3. mcpSecrets 收集凭据值供 MCP 输出和错误脱敏；配置只在后端内存中持有，修改后须重启。
 * 本地配置属于用户信任的启动配置，不是模型可提交的连接/程序参数；它不提供操作系统隔离。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const values = z.record(z.string().min(1).max(256), z.string().max(8192));
const common = {
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(300000).default(60000),
};
const endpoint = z
  .string()
  .url()
  .max(8192)
  .refine((value) => {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    );
  });

export const mcpServerSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...common,
      transport: z.literal("stdio"),
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(8192)).max(100).default([]),
      cwd: z.string().min(1).refine(path.isAbsolute).optional(),
      env: values.default({}),
    })
    .strict(),
  z
    .object({
      ...common,
      transport: z.literal("http"),
      url: endpoint,
      headers: values.default({}),
    })
    .strict(),
]);

const configurationSchema = z
  .object({
    mcpServers: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
        mcpServerSchema,
      )
      .refine((servers) => Object.keys(servers).length <= 32),
  })
  .strict();

export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpServers = Record<string, McpServer>;

export function loadMcpServers(directory: string): McpServers {
  const explicit = process.env.CODEATELIER_MCP_CONFIG;
  if (explicit && !path.isAbsolute(explicit)) {
    throw new Error("CODEATELIER_MCP_CONFIG 必须是绝对路径。");
  }

  const file = explicit || path.join(directory, "mcp.json");
  if (!explicit && !existsSync(file)) {
    return {};
  }

  try {
    if (statSync(file).size > 1024 * 1024) {
      throw new Error("oversized");
    }

    // Windows PowerShell 的 UTF-8 输出可能带 BOM；仅去除文件开头的标记。
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");

    return configurationSchema.parse(JSON.parse(text)).mcpServers;
  } catch {
    // JSON/Zod/文件异常可能带有原始凭据，启动错误不附原始 cause。
    throw new Error(
      "MCP 配置读取或校验失败；检查 mcpServers、transport、绝对路径和 HTTPS 地址（本机 HTTP 除外）。",
    );
  }
}

export function mcpSecrets(servers: McpServers): string[] {
  return Object.values(servers).flatMap((server) =>
    server.transport === "stdio"
      ? Object.values(server.env)
      : [
          ...Object.values(server.headers).flatMap((value) => [
            value,
            value.replace(/^Bearer\s+/i, ""),
          ]),
          server.url,
          ...new URL(server.url).searchParams.values(),
        ],
  );
}
