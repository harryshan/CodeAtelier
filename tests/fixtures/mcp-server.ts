/**
 * 离线 MCP stdio 集成夹具，由 mcp.test 和 mcp-engine.test 以独立 Node 进程启动。
 * 使用官方 McpServer/stdio transport，不依赖模型、个人凭据或网络。
 *
 * 1. echo 返回 PID、调用次数、显式测试环境和是否误继承模型密钥，用于验证连接复用与环境隔离。
 * 2. fail/slow 分别返回 MCP 业务错误和可取消的延迟操作；不执行真实文件副作用。
 * 3. note 资源和 greet 提示模板覆盖 MCP 非工具接口；仅通过协议 stdout 输出，不打印日志。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "offline-fixture", version: "1.0.0" });
let calls = 0;
server.registerTool(
  "echo",
  { inputSchema: { text: z.string() } },
  async ({ text }) => {
    calls += 1;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            text,
            pid: process.pid,
            calls,
            secret: process.env.MCP_TEST_SECRET,
            inheritedKey: !!process.env.CODEATELIER_API_KEY,
          }),
        },
      ],
    };
  },
);
server.registerTool("fail", {}, async () => ({
  isError: true,
  content: [{ type: "text", text: "fixture tool failure" }],
}));
server.registerTool("slow", {}, async (extra) => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10000);
    extra.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

  return { content: [{ type: "text", text: "late" }] };
});
server.registerResource("note", "fixture://note", {}, async (uri) => ({
  contents: [
    { uri: uri.href, text: "resource fixture", mimeType: "text/plain" },
  ],
}));
server.registerPrompt(
  "greet",
  { argsSchema: { name: z.string() } },
  async ({ name }) => ({
    messages: [
      { role: "user", content: { type: "text", text: `hello ${name}` } },
    ],
  }),
);
await server.connect(new StdioServerTransport());
