/**
 * 给多协议离线测试提供真实本机 HTTP/SSE 服务，绝不连接外部模型。
 * 1. chatFrames/messagesFrames 生成文字或多函数调用的标准分片及完成事件。
 * 2. withProtocolServer 收集实际请求，按测试回调回复状态/帧；小字节块验证 UTF-8 与 SSE 边界。
 * 3. finally 关闭所有连接和监听；hang 用于取消/时限测试，不留下后台服务。
 */
import { createServer, type IncomingHttpHeaders } from "node:http";

export interface ProtocolRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface TestCall {
  id: string;
  name: string;
  args: string;
}

export function chatFrames(text = "完成", calls: TestCall[] = []): any[] {
  return [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    ...calls.flatMap((call, index) => [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: call.args.slice(0, 2),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index, function: { arguments: call.args.slice(2) } },
              ],
            },
          },
        ],
      },
    ]),
    {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: calls.length ? "tool_calls" : "stop",
        },
      ],
    },
    {
      choices: [],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 5,
        total_tokens: 20,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
    "[DONE]",
  ];
}

export function messagesFrames(text = "完成", calls: TestCall[] = []): any[] {
  return [
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    },
    { type: "ping" },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    ...calls.flatMap((call, index) => [
      {
        type: "content_block_start",
        index: index + 1,
        content_block: {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: index + 1,
        delta: {
          type: "input_json_delta",
          partial_json: call.args.slice(0, 2),
        },
      },
      {
        type: "content_block_delta",
        index: index + 1,
        delta: { type: "input_json_delta", partial_json: call.args.slice(2) },
      },
      { type: "content_block_stop", index: index + 1 },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: calls.length ? "tool_use" : "end_turn" },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
}

export async function withProtocolServer(
  reply: (
    request: ProtocolRequest,
    index: number,
  ) => {
    frames?: any[];
    raw?: string;
    status?: number;
    hang?: boolean;
    contentType?: string;
  },
  run: (baseUrl: string, requests: ProtocolRequest[]) => Promise<void>,
) {
  const requests: ProtocolRequest[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
    }

    const captured = {
      url: request.url!,
      headers: request.headers,
      body: body ? JSON.parse(body) : undefined,
    };
    requests.push(captured);
    const result = reply(captured, requests.length - 1);
    response.writeHead(result.status ?? 200, {
      "content-type": result.contentType ?? "text/event-stream",
      "retry-after": "1",
    });
    response.flushHeaders();
    const payload =
      result.raw ??
      result.frames
        ?.map(
          (event) =>
            `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\r\n\r\n`,
        )
        .join("") ??
      "";
    const bytes = Buffer.from(payload);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      response.write(bytes.subarray(offset, offset + 7));
    }

    if (!result.hang) {
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await run(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
