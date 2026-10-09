/**
 * 验证 MCP 配置向模型公开的目录投影；纯内存夹具不连接网络、不启动 MCP 或调用模型。
 * 1. 配置校验覆盖 stdio/HTTP 的可选用途、修剪、长度边界和旧配置兼容。
 * 2. catalog 验证已启用过滤、未知用途、空目录和凭据脱敏；只暴露名称、transport 与 description。
 * 3. Runtime start_task 覆盖最坏 JSON 转义后的完整目录以及旧版本握手拒绝，防止宿主/Runtime 行为分叉。
 * Engine 的真实 Node 子进程与首次模型可见性由 mcp-engine.test.ts 另外覆盖。
 */
import { expect, it } from "vitest";
import { mcpServerSchema } from "../src/mcp/config.js";
import {
  mcpCatalogInstructions,
  mcpServerCatalog,
} from "../src/mcp/catalog.js";
import { runtimeIpcMessageSchema } from "../src/sandbox/runtime-ipc-protocol.js";

it.each([
  { transport: "stdio", command: "never-start" },
  { transport: "http", url: "https://example.com/mcp" },
])("validates optional purpose descriptions for $transport", (connection) => {
  expect(mcpServerSchema.parse(connection).description).toBeUndefined();
  expect(
    mcpServerSchema.parse({ ...connection, description: "  Search notes  " })
      .description,
  ).toBe("Search notes");
  expect(
    mcpServerSchema.safeParse({ ...connection, description: "x".repeat(1024) })
      .success,
  ).toBe(true);

  for (const description of ["", " \n ", "x".repeat(1025), null, 42]) {
    expect(
      mcpServerSchema.safeParse({ ...connection, description }).success,
    ).toBe(false);
  }
});

it("projects only enabled public metadata and redacts configured secrets in descriptions", () => {
  const servers = {
    notes: mcpServerSchema.parse({
      transport: "stdio",
      command: "private-executable",
      args: ["private-script"],
      env: { SERVICE_KEY: "catalog-secret-159" },
      description: "Search notes catalog-secret-159 remote-secret-847",
    }),
    remote: mcpServerSchema.parse({
      transport: "http",
      url: "https://example.com/team-endpoint",
      headers: { Authorization: "Bearer team-secret-481" },
      description: "Query team issues",
    }),
    legacy: mcpServerSchema.parse({
      transport: "stdio",
      command: "never-start",
    }),
    hidden: mcpServerSchema.parse({
      transport: "http",
      url: "https://example.com/private-endpoint",
      headers: { Authorization: "Bearer remote-secret-847" },
      description: "Hidden capability",
      enabled: false,
    }),
  };
  expect(mcpServerCatalog(servers)).toEqual([
    {
      name: "notes",
      transport: "stdio",
      description: "Search notes [REDACTED] [REDACTED]",
    },
    { name: "remote", transport: "http", description: "Query team issues" },
    { name: "legacy", transport: "stdio", description: null },
  ]);
  const instructions = mcpCatalogInstructions(servers);
  expect(instructions).toContain("not permission grants");
  expect(instructions).toContain("Discover the actual tool inputSchema");
  expect(instructions).toContain("require Broker approval");
  for (const privateText of [
    "private-executable",
    "private-script",
    "private-endpoint",
    "team-endpoint",
    "team-secret-481",
    "catalog-secret-159",
    "remote-secret-847",
    "Hidden capability",
  ]) {
    expect(instructions).not.toContain(privateText);
  }

  expect(mcpServerCatalog({})).toEqual([]);
  expect(mcpCatalogInstructions({})).toContain(
    "No configured servers means no MCP service is available",
  );
});

it("keeps descriptions bounded even when redaction expands a short secret", () => {
  const servers = {
    notes: mcpServerSchema.parse({
      transport: "stdio",
      command: "never-start",
      env: { SERVICE_KEY: "x" },
      description: "x".repeat(1024),
    }),
  };
  expect(mcpServerCatalog(servers)[0]?.description).toHaveLength(1024);
  expect(mcpServerCatalog(servers)[0]?.description).not.toContain("x");
});

it("transfers the maximum escaped catalog and rejects oversized text and old Runtime handshakes", () => {
  const servers = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `server-${index}`,
      mcpServerSchema.parse({
        transport: "stdio",
        command: "never-start",
        description: "\u0001".repeat(1024),
      }),
    ]),
  );
  const mcpText = mcpCatalogInstructions(servers);
  expect(mcpText.length).toBeGreaterThan(190_000);
  const request = {
    type: "request",
    requestId: "start",
    operation: "start_task",
    body: {
      workspace: "workspace",
      prompt: "Use relevant services",
      mcpText,
      settings: {
        model: "test",
        maxSteps: 2,
        commandTimeoutMs: 1000,
        contextChars: 10000,
        outputChars: 1000,
      },
    },
  };
  expect(runtimeIpcMessageSchema.safeParse(request).success).toBe(true);
  expect(
    runtimeIpcMessageSchema.safeParse({
      ...request,
      body: { ...request.body, mcpText: "x".repeat(250_001) },
    }).success,
  ).toBe(false);
  const hello = {
    type: "runtime_hello",
    protocolVersion: 10,
    taskId: "task",
    sessionId: "session",
    executionInstanceId: "instance",
    nonce: "n".repeat(32),
  };
  expect(runtimeIpcMessageSchema.safeParse(hello).success).toBe(true);
  expect(
    runtimeIpcMessageSchema.safeParse({ ...hello, protocolVersion: 9 }).success,
  ).toBe(false);
});
