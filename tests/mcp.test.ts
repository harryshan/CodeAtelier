/**
 * 验证本机 MCP 配置与任务客户端的可观察行为，全部使用临时目录、真实 stdio 子进程或回环 HTTP 夹具。
 *
 * 1. 配置用例覆盖缺省关闭、坏文件/越界字段拒绝以及凭据不出现在公开设置；list_servers 返回用途摘要且不连接。
 * 2. stdio 用例验证审批先于启动、发现/分页字段、连接复用、环境最小继承、工具/资源/模板往返与错误语义。
 * 3. 握手超时后直接进程必须已退出；无操作期限/取消先确认握手与调用就绪，再核对退出和禁止重放；HTTP 核对认证头、分页、DELETE、重定向与响应流大小限制。
 *    配置覆盖 Windows UTF-8 BOM，禁用服务不连接；凭据回显包含无 Bearer 前缀的原 token。
 * 4. Trace 和日志只含安全阶段与关联 ID，不包含配置凭据或 MCP 正文；不启动 Evaluation 或真实模型。
 */
import { createServer } from "node:http";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import { loadMcpServers, mcpServerSchema } from "../src/mcp/config.js";
import { McpTaskClient } from "../src/mcp/task-client.js";
import type { McpAction } from "../src/mcp/contracts.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { toolSucceeded } from "../src/tools/model-tool-batch.js";
import { temp } from "./fixtures/helpers.js";

const clients: McpTaskClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.unstubAllEnvs();
});

async function fixture(
  approve = true,
  timeoutMs = 5000,
  outputChars = 32000,
  startupDelayMs = 0,
) {
  const traces = new TraceRecorder();
  traces.startTask("mcp-task", "session");
  const approval = vi.fn(async () => approve);
  const workspace = await temp();
  const pidFile = path.join(workspace, "mcp.pid");
  const local = mcpServerSchema.parse({
    description: "Echo and inspect fixture notes",
    transport: "stdio",
    command: process.execPath,
    args: [path.resolve("tests/fixtures/mcp-server.ts")],
    env: {
      MCP_TEST_SECRET: "fixture-secret-731",
      // MCP 将 env 值视为凭据；不要把无延迟的 "0" 注入，以免 PID 正文中的数字被脱敏。
      ...(startupDelayMs > 0
        ? { MCP_TEST_STARTUP_DELAY_MS: String(startupDelayMs) }
        : {}),
      MCP_TEST_PID_FILE: pidFile,
      MCP_TEST_STARTED_FILE: path.join(workspace, "slow.started"),
    },
    timeoutMs,
  });
  if (local.transport !== "stdio") {
    throw new Error("MCP 测试夹具必须使用 stdio。");
  }

  const client = new McpTaskClient({
    servers: {
      disabled: mcpServerSchema.parse({
        transport: "stdio",
        command: "never-start-this",
        enabled: false,
      }),
      local,
    },
    workspace,
    taskId: "mcp-task",
    sessionId: "session",
    outputChars,
    approve: approval,
    traces,
    log: pino({ enabled: false }),
  });
  clients.push(client);
  const run = async (
    action: McpAction,
    signal = new AbortController().signal,
  ) => {
    const execute = await client.prepare(action, "call-fixture", signal);

    return execute(signal);
  };

  return { client, approval, traces, run, pidFile, local, workspace };
}

it("waits for a timed-out stdio handshake to release its process before returning", async () => {
  const { client, run, pidFile, local, traces } = await fixture(true, 3000);
  // 不加载 SDK 的轻量子进程始终不回复握手，并在 stdin 关闭后继续存活，强制覆盖 SDK 的异步终止阶段。
  local.args = [
    "-e",
    "require('node:fs').writeFileSync(process.env.MCP_TEST_PID_FILE, String(process.pid));setInterval(()=>{},1000)",
  ];
  try {
    expect(
      await run({ action: "list_tools", server: "local", cursor: null }),
    ).toMatchObject({ outcome: "unknown" });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    const cleanup = traces
      .exportTask("mcp-task")
      ?.traceEvents.find((event) => event.name === "mcp.connection_close");
    expect(cleanup).toMatchObject({
      ph: "X",
      args: { status: "ok", callId: "call-fixture" },
    });
    expect(cleanup?.dur).toBeGreaterThan(0);
    await expect(
      run({ action: "list_tools", server: "local", cursor: null }),
    ).rejects.toThrow("不自动重连");
  } finally {
    await client.close();
  }
});

it("loads MCP only from backend configuration and keeps credentials out of public settings", async () => {
  const directory = await temp();
  expect(loadMcpServers(directory)).toEqual({});
  await writeFile(
    path.join(directory, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer fixture-token" },
        },
      },
    }),
  );
  const config = new Config(directory);
  expect(config.mcpServers.remote).toMatchObject({
    transport: "http",
    timeoutMs: 60000,
  });
  expect(JSON.stringify(config.publicValue())).not.toContain("fixture-token");
  expect(JSON.stringify(config.publicValue())).not.toContain("mcpServers");
  vi.stubEnv("CODEATELIER_MCP_CONFIG", "relative.json");
  expect(() => loadMcpServers(directory)).toThrow("绝对路径");
});

it("accepts Windows PowerShell UTF-8 BOM configuration", async () => {
  const directory = await temp();
  await writeFile(path.join(directory, "mcp.json"), '\uFEFF{"mcpServers":{}}');
  expect(loadMcpServers(directory)).toEqual({});
});

it("rejects malformed configuration, insecure remote URLs and arbitrary connection fields", async () => {
  const directory = await temp();
  await writeFile(path.join(directory, "mcp.json"), '{"secret":"do-not-echo",');
  expect(() => loadMcpServers(directory)).toThrow("配置读取或校验失败");
  for (const url of [
    "http://example.com/mcp",
    "https://user:password@example.com/mcp",
    "file:///tmp/mcp",
  ]) {
    expect(mcpServerSchema.safeParse({ transport: "http", url }).success).toBe(
      false,
    );
  }

  expect(
    mcpServerSchema.safeParse({
      transport: "stdio",
      command: "node",
      shell: true,
    }).success,
  ).toBe(false);
});

it("lists public service descriptions without approval and rejects operations before starting denied or unknown servers", async () => {
  const { client, approval, run } = await fixture(false);
  expect(await run({ action: "list_servers" })).toEqual({
    execution: { kind: "broker-mcp", mode: "host-process" },
    data: [
      {
        name: "local",
        transport: "stdio",
        description: "Echo and inspect fixture notes",
      },
    ],
  });
  expect(approval).not.toHaveBeenCalled();
  await expect(
    run({ action: "list_tools", server: "disabled", cursor: null }),
  ).rejects.toThrow("未启用");
  await expect(
    run({ action: "list_tools", server: "missing", cursor: null }),
  ).rejects.toThrow("不存在");
  await expect(
    run({ action: "list_tools", server: "local", cursor: null }),
  ).rejects.toThrow("审批未通过");
  await expect(
    client.prepare(
      {
        action: "call_tool",
        server: "local",
        name: "echo",
        argumentsJson: "[]",
      },
      "bad",
      new AbortController().signal,
    ),
  ).rejects.toThrow("JSON 对象");
  await expect(
    run({
      action: "get_prompt",
      server: "local",
      name: "greet",
      argumentsJson: '{"name":1}',
    }),
  ).rejects.toThrow("字符串");
});

it("round trips tools, resources and prompt data over a reusable local stdio connection", async () => {
  vi.stubEnv("CODEATELIER_API_KEY", "must-not-inherit-model-key");
  const { client, traces, run } = await fixture();
  const tools = await run({
    action: "list_tools",
    server: "local",
    cursor: null,
  });
  expect(JSON.stringify(tools)).toContain('"echo"');
  const action = {
    action: "call_tool",
    server: "local",
    name: "echo",
    argumentsJson: '{"text":"sensitive-payload-934"}',
  } as const;
  const first = await run(action);
  const second = await run(action);
  const firstValue = JSON.parse((first.data as any).content[0].text);
  const secondValue = JSON.parse((second.data as any).content[0].text);
  expect(firstValue).toMatchObject({
    calls: 1,
    inheritedKey: false,
    secret: "[REDACTED]",
  });
  expect(secondValue).toMatchObject({ calls: 2, pid: firstValue.pid });
  expect(
    JSON.stringify(
      await run({ action: "list_resources", server: "local", cursor: null }),
    ),
  ).toContain("fixture://note");
  expect(
    JSON.stringify(
      await run({
        action: "read_resource",
        server: "local",
        uri: "fixture://note",
      }),
    ),
  ).toContain("resource fixture");
  expect(
    await run({
      action: "list_resource_templates",
      server: "local",
      cursor: null,
    }),
  ).toMatchObject({ data: { resourceTemplates: [] } });
  expect(
    JSON.stringify(
      await run({ action: "list_prompts", server: "local", cursor: null }),
    ),
  ).toContain("greet");
  expect(
    JSON.stringify(
      await run({
        action: "get_prompt",
        server: "local",
        name: "greet",
        argumentsJson: '{"name":"reader"}',
      }),
    ),
  ).toContain("hello reader");
  const failed = await run({
    action: "call_tool",
    server: "local",
    name: "fail",
    argumentsJson: "{}",
  });
  expect(failed.error).toContain("执行失败");
  expect(toolSucceeded(failed)).toBe(false);
  await client.close();
  expect(() => process.kill(firstValue.pid, 0)).toThrow();
  await expect(run({ action: "list_servers" })).rejects.toThrow("已关闭");
  const trace = JSON.stringify(traces.exportTask("mcp-task"));
  expect(trace).toContain("mcp.connect");
  expect(trace).toContain("mcp.close");
  expect(trace).not.toContain("sensitive-payload-934");
  expect(trace).not.toContain("fixture-secret-731");
});

it("consumes approvals once and marks output truncation without dropping business failures", async () => {
  const { client } = await fixture(true, 5000, 40);
  const signal = new AbortController().signal;
  const execute = await client.prepare(
    { action: "call_tool", server: "local", name: "fail", argumentsJson: "{}" },
    "fail",
    signal,
  );
  expect(await execute(signal)).toMatchObject({
    truncated: true,
    error: expect.any(String),
  });
  await expect(execute(signal)).rejects.toThrow("不能重放");
});

it.each(["past-deadline", "cancel"])(
  "waits without a deadline (%s), closes on cancellation and refuses replay",
  async (mode) => {
    const { client, run, local, workspace, pidFile } = await fixture(
      true,
      10000,
      32000,
      0,
    );
    // 完成握手后再施加取消，确保覆盖已发送调用而非仅取消启动。
    const discovery = await run({
      action: "list_tools",
      server: "local",
      cursor: null,
    });
    expect(discovery.error).toBeUndefined();
    expect(discovery.data).toHaveProperty("tools");
    // 已有连接后缩短旧配置；它现在只管未来握手，不能截断正在执行的工具。
    local.timeoutMs = 100;
    const startedFile = path.join(workspace, "slow.started");
    const controller = new AbortController();
    const promise = run(
      {
        action: "call_tool",
        server: "local",
        name: "slow",
        argumentsJson: "{}",
      },
      controller.signal,
    );
    try {
      await expect
        .poll(() => readFile(startedFile, "utf8"), { timeout: 5000 })
        .toBe("ready");
      if (mode === "past-deadline") {
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(settled).toBe(false);
      }

      controller.abort(new Error("fixture cancellation"));

      expect(await promise).toMatchObject({
        outcome: "unknown",
        error: expect.stringContaining("不得自动重放"),
      });
      await expect(
        run({ action: "list_tools", server: "local", cursor: null }),
      ).rejects.toThrow("不自动重连");
      expect(await readFile(startedFile, "utf8")).toBe("ready");
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await promise;
      await client.close();
    }
  },
);

it.each(["normal", "redirect", "oversize"])(
  "uses backend HTTP credentials and handles %s connection cleanup",
  async (mode) => {
    const requests: Array<{
      method: string;
      authorization?: string;
      params: any;
    }> = [];
    let redirect = false;
    let oversized = false;
    let deletes = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        deletes += 1;
        expect(request.headers["mcp-session-id"]).toBe("fixture-session");
        response.writeHead(200).end();

        return;
      }

      if (request.method === "GET") {
        response.writeHead(405).end();

        return;
      }

      if (redirect) {
        response
          .writeHead(302, { Location: "http://127.0.0.1:1/forbidden" })
          .end();

        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }

      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({
        method: body.method,
        authorization: request.headers.authorization,
        params: body.params,
      });
      if (body.id === undefined) {
        response.writeHead(202).end();

        return;
      }

      const result = oversized
        ? { content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] }
        : body.method === "initialize"
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1" },
            }
          : body.method === "tools/list"
            ? { tools: [], nextCursor: "page-two" }
            : { content: [{ type: "text", text: "http-fixture-token" }] };
      response
        .writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "fixture-session",
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const client = new McpTaskClient({
      servers: {
        remote: mcpServerSchema.parse({
          transport: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: "Bearer http-fixture-token" },
          timeoutMs: 3000,
        }),
      },
      workspace: await temp(),
      taskId: "http-task",
      sessionId: "session",
      outputChars: 32000,
      approve: async () => true,
      log: pino({ enabled: false }),
      traces: new TraceRecorder(),
    });
    const signal = new AbortController().signal;
    const run = async (action: McpAction) =>
      (await client.prepare(action, "http-call", signal))(signal);
    try {
      expect(
        await run({
          action: "list_tools",
          server: "remote",
          cursor: "page-one",
        }),
      ).toMatchObject({ data: { nextCursor: "page-two" } });
      expect(
        requests.find((request) => request.method === "tools/list"),
      ).toMatchObject({
        authorization: "Bearer http-fixture-token",
        params: { cursor: "page-one" },
      });
      expect(
        JSON.stringify(
          await run({
            action: "call_tool",
            server: "remote",
            name: "echo",
            argumentsJson: "{}",
          }),
        ),
      ).not.toContain("http-fixture-token");
      if (mode !== "normal") {
        redirect = mode === "redirect";
        oversized = mode === "oversize";
        expect(
          await run({ action: "list_tools", server: "remote", cursor: null }),
        ).toMatchObject({ outcome: "unknown" });
      }

      await client.close();
      expect(deletes).toBe(mode === "normal" ? 1 : 0);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
