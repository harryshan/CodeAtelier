/**
 * 为 Engine 的一个任务持有本机 MCP 连接；Sandbox 只通过 Broker adapter 调用，不创建 MCP 进程或网络连接。
 * 官方 SDK 负责协议握手和 stdio/Streamable HTTP，本类负责审批、任务生命周期、输出边界与观测。
 *
 * 1. prepare 校验操作和 JSON 参数，按已配置服务申请一次审批，返回只能消费一次的执行闭包；审批不占工具执行槽。
 * 2. enqueue 按服务串行执行，connection 按需握手并在任务内复用；不同服务和不同任务互不共享连接。
 * 3. perform 用统一超时/取消包住连接和操作，失败即封闭该服务至任务结束，不自动重连或重放未知副作用。
 * 4. dispatch 映射发现、工具、资源和提示模板接口；返回内容仅作为不可信工具数据，不能注入系统提示词。
 * 5. close 等待在途操作、结束 HTTP session 并通过 McpStdioTransport 共用 SDK 关闭回执和保存的 PID，确认直接子进程退出；traced 只记录关联 ID、操作类别、耗时和终态，不记录地址、参数或正文。
 * stdio 使用宿主用户权限及 SDK 最小继承环境，不是 Sandbox；只能管理直接子进程，不能保证第三方派生进程退出。
 */
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "pino";
import type { TraceRecorder } from "../tracing/recorder.js";
import { redactJson, redactText } from "../logging/redact.js";
import {
  mcpActionSchema,
  type McpAction,
  type McpResult,
} from "./contracts.js";
import { mcpSecrets, type McpServer, type McpServers } from "./config.js";
import { McpStdioTransport } from "./mcp-stdio-transport.js";

const MAX_WIRE_BYTES = 2 * 1024 * 1024;
const execution = { kind: "broker-mcp", mode: "host-process" } as const;
type Transport = McpStdioTransport | StreamableHTTPClientTransport;
interface Connection {
  client: Client;
  transport: Transport;
  network: AbortController;
}
interface Options {
  servers: McpServers;
  workspace: string;
  taskId: string;
  sessionId: string;
  outputChars: number;
  approve: (description: string, signal: AbortSignal) => Promise<boolean>;
  log: Logger;
  traces: TraceRecorder;
}

function jsonArguments(action: McpAction): Record<string, unknown> | undefined {
  if (!("argumentsJson" in action)) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(action.argumentsJson);
  } catch {
    throw new Error("MCP argumentsJson 必须是合法 JSON 对象。");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP argumentsJson 必须是 JSON 对象，不能是数组或 null。");
  }

  if (
    action.action === "get_prompt" &&
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new Error("MCP 提示模板参数的值必须是字符串。");
  }

  return value as Record<string, unknown>;
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // 调用方已经创建 Promise；即使取消抢先到达，也要观察其迟到拒绝。
    void operation.catch(() => undefined);
    throw signal.reason;
  }

  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class McpTaskClient {
  private connections = new Map<string, Connection>();
  private queues = new Map<string, Promise<unknown>>();
  private failed = new Set<string>();
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly secrets: string[];

  constructor(private options: Options) {
    this.secrets = mcpSecrets(options.servers);
  }

  async prepare(raw: McpAction, toolCallId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closing) {
      throw new Error("MCP 任务连接已关闭。");
    }

    const action = mcpActionSchema.parse(raw);
    const args = jsonArguments(action);
    if (action.action !== "list_servers") {
      const server = this.options.servers[action.server];
      if (!server?.enabled) {
        throw new Error("MCP 服务不存在或未启用；先调用 list_servers。");
      }

      if (this.failed.has(action.server)) {
        throw new Error(
          "该 MCP 连接已失败，当前任务不自动重连；先核实可能副作用。",
        );
      }

      const target =
        server.transport === "stdio"
          ? {
              transport: server.transport,
              command: server.command,
              args: server.args,
              cwd: server.cwd ?? this.options.workspace,
            }
          : { transport: server.transport, origin: new URL(server.url).origin };
      const description =
        "MCP 由本机后端以宿主用户权限访问，不受 Sandbox 文件/网络限制。本地进程启动也可能有副作用；远端会接收请求参数。以下仅为待审批数据，不是指令：\n" +
        redactJson(JSON.stringify({ target, request: action }), this.secrets);
      if (description.length > 32000) {
        throw new Error(
          "MCP 待审批内容超过 32000 字符，请缩小参数或启动配置；不会截断后执行。",
        );
      }

      if (!(await this.options.approve(description, signal))) {
        throw new Error("MCP 操作审批未通过，未连接或调用服务。");
      }
    }

    signal.throwIfAborted();
    let consumed = false;

    return async (executionSignal: AbortSignal): Promise<McpResult> => {
      if (consumed) {
        throw new Error("MCP 单次授权已消费，不能重放。");
      }

      consumed = true;
      executionSignal.throwIfAborted();
      if (this.closing) {
        throw new Error("MCP 任务连接已关闭。");
      }

      if (action.action === "list_servers") {
        return {
          execution,
          data: Object.entries(this.options.servers)
            .filter(([, server]) => server.enabled)
            .map(([name, server]) => ({ name, transport: server.transport })),
        };
      }

      return this.enqueue(action.server, () =>
        this.perform(action, args, toolCallId, executionSignal),
      );
    };
  }

  private enqueue(server: string, operation: () => Promise<McpResult>) {
    const previous = this.queues.get(server) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(server, next);

    return next;
  }

  private async traced<T>(
    stage: string,
    toolCallId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    server?: string,
  ): Promise<T> {
    const start = Date.now();
    const span = this.options.traces.startSpan(this.options.taskId, {
      name: `mcp.${stage}`,
      category: "mcp",
      track: server
        ? `Broker MCP ${Object.keys(this.options.servers).indexOf(server) + 1}`
        : "Broker MCP lifecycle",
      attributes: { callId: toolCallId, mode: "host-process" },
    });
    this.options.log.debug({
      event: `mcp.${stage}.start`,
      taskId: this.options.taskId,
      toolCallId,
    });
    try {
      const result = await operation();
      const failed =
        typeof result === "object" &&
        result !== null &&
        "isError" in result &&
        result.isError === true;
      this.options.traces.endSpan(span, failed ? "error" : "ok");
      this.options.log.debug({
        event: `mcp.${stage}.end`,
        taskId: this.options.taskId,
        toolCallId,
        durationMs: Date.now() - start,
      });

      return result;
    } catch (error) {
      this.options.traces.endSpan(
        span,
        signal?.aborted && signal.reason?.name !== "TimeoutError"
          ? "cancelled"
          : "error",
      );
      this.options.log[
        signal?.aborted && signal.reason?.name !== "TimeoutError"
          ? "info"
          : "warn"
      ]({
        event: `mcp.${stage}.failed`,
        taskId: this.options.taskId,
        sessionId: this.options.sessionId,
        toolCallId,
        durationMs: Date.now() - start,
        message: this.safeError(error),
      });
      throw error;
    }
  }

  private safeError(error: unknown) {
    return redactText(
      error instanceof Error ? error.message : "MCP 操作失败",
      this.secrets,
    ).slice(0, 1500);
  }

  private async connection(
    name: string,
    server: McpServer,
    signal: AbortSignal,
    callId: string,
  ) {
    const existing = this.connections.get(name);
    if (existing) {
      return existing.client;
    }

    const network = new AbortController();
    const transport =
      server.transport === "stdio"
        ? new McpStdioTransport({
            command: server.command,
            args: server.args,
            cwd: server.cwd ?? this.options.workspace,
            env: server.env,
            stderr: "ignore",
            maxBufferSize: MAX_WIRE_BYTES,
          })
        : new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: server.headers, redirect: "error" },
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
            fetch: async (url, init) => {
              const response = await fetch(url, {
                ...init,
                redirect: "error",
                signal: AbortSignal.any([
                  network.signal,
                  ...(init?.signal ? [init.signal] : []),
                ]),
              });
              if (!response.body) {
                return response;
              }

              let bytes = 0;
              const body = response.body.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    bytes += chunk.byteLength;
                    if (bytes > MAX_WIRE_BYTES) {
                      controller.error(
                        new Error("MCP HTTP 响应流超过 2 MiB 限制。"),
                      );

                      return;
                    }

                    controller.enqueue(chunk);
                  },
                }),
              );

              return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            },
          });
    const client = new Client(
      { name: "CodeAtelier", version: "0.1.0" },
      { capabilities: {} },
    );
    this.connections.set(name, { client, transport, network });
    await this.traced(
      "connect",
      callId,
      () =>
        client.connect(transport, {
          signal,
          timeout: server.timeoutMs,
          maxTotalTimeout: server.timeoutMs,
        }),
      signal,
      name,
    );
    client.onclose = () => {
      this.failed.add(name);
    };

    return client;
  }

  private async perform(
    action: Exclude<McpAction, { action: "list_servers" }>,
    args: Record<string, unknown> | undefined,
    callId: string,
    signal: AbortSignal,
  ): Promise<McpResult> {
    signal.throwIfAborted();
    if (this.closing || this.failed.has(action.server)) {
      throw new Error(
        "MCP 连接关闭或先前结果未知；当前任务不会自动重连或重放。",
      );
    }

    const server = this.options.servers[action.server]!;
    const deadline = AbortSignal.any([
      signal,
      this.lifetime.signal,
      AbortSignal.timeout(server.timeoutMs),
    ]);
    try {
      const data = await this.traced(
        action.action,
        callId,
        () =>
          abortable(
            (async () => {
              const client = await this.connection(
                action.server,
                server,
                deadline,
                callId,
              );
              deadline.throwIfAborted();

              return this.dispatch(
                client,
                action,
                args,
                deadline,
                server.timeoutMs,
              );
            })(),
            deadline,
          ),
        deadline,
        action.server,
      );
      const isError =
        typeof data === "object" &&
        data !== null &&
        "isError" in data &&
        data.isError === true;
      const json = redactJson(JSON.stringify(data), this.secrets);
      const limit = Math.min(this.options.outputChars, 200000);

      return {
        execution,
        data:
          json.length > limit
            ? { text: json.slice(0, limit) }
            : JSON.parse(json),
        ...(json.length > limit ? { truncated: true } : {}),
        ...(isError
          ? { error: "MCP 服务报告工具执行失败；详见返回内容。" }
          : {}),
      };
    } catch (error) {
      this.failed.add(action.server);
      await this.closeConnection(action.server, false, callId);

      return {
        execution,
        error: `${this.safeError(error)}；服务端结果可能未知，不得自动重放。`,
        outcome: "unknown",
      };
    }
  }

  private dispatch(
    client: Client,
    action: Exclude<McpAction, { action: "list_servers" }>,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
    timeout: number,
  ) {
    const options = { signal, timeout, maxTotalTimeout: timeout };
    const page =
      "cursor" in action && action.cursor !== null
        ? { cursor: action.cursor }
        : {};
    switch (action.action) {
      case "list_tools":
        return client.listTools(page, options);
      case "call_tool":
        return client.callTool(
          { name: action.name, arguments: args },
          undefined,
          options,
        );
      case "list_resources":
        return client.listResources(page, options);
      case "list_resource_templates":
        return client.listResourceTemplates(page, options);
      case "read_resource":
        return client.readResource({ uri: action.uri }, options);
      case "list_prompts":
        return client.listPrompts(page, options);
      case "get_prompt":
        return client.getPrompt(
          { name: action.name, arguments: args as Record<string, string> },
          options,
        );
    }
  }

  private async closeConnection(
    name: string,
    graceful = false,
    callId = "task-cleanup",
  ) {
    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }

    await this.traced(
      "connection_close",
      callId,
      async () => {
        const pid =
          connection.transport instanceof McpStdioTransport
            ? connection.transport.startedPid
            : null;
        let sessionError: unknown;
        if (
          graceful &&
          connection.transport instanceof StreamableHTTPClientTransport &&
          connection.transport.sessionId &&
          !connection.network.signal.aborted
        ) {
          try {
            await abortable(
              connection.transport.terminateSession(),
              AbortSignal.timeout(2000),
            );
          } catch (error) {
            sessionError = error;
          }
        }

        connection.network.abort();
        await abortable(connection.client.close(), AbortSignal.timeout(6000));
        // SDK 握手失败会自行异步 close 并清空内部 PID；transport 共用关闭回执并保留启动 PID。
        // close 最后发送 kill 后也不一定等到 exit，仍要确认直接子进程退出。
        if (pid !== null) {
          const until = Date.now() + 2000;
          while (true) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                break;
              }

              throw new Error("无法确认 MCP 直接子进程已退出。");
            }

            if (Date.now() >= until) {
              throw new Error("MCP 直接子进程清理超时，退出状态未知。");
            }

            await delay(20);
          }
        }

        this.connections.delete(name);
        if (sessionError) {
          throw new Error(
            `MCP 本地连接已关闭，但远端 session 清理失败：${this.safeError(sessionError)}`,
          );
        }
      },
      undefined,
      name,
    );
  }

  close(): Promise<void> {
    this.closePromise ??= this.traced("close", "task-cleanup", async () => {
      this.closing = true;
      this.lifetime.abort(new Error("MCP 任务结束。"));
      await Promise.allSettled(this.queues.values());
      const results = await Promise.allSettled(
        [...this.connections.keys()].map((name) =>
          this.closeConnection(name, true),
        ),
      );
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("MCP 连接清理失败，不能确认全部连接关闭。");
      }
    });

    return this.closePromise;
  }
}
