/**
 * 用本机 HTTP/SSE 服务模拟 Responses 响应，检查真实 ResponsesProvider 的解析和请求参数。
 * withServer 提供服务及清理，不连接外部模型。
 *
 * 1. completed.output 为空时，从 item.done 收集完整工具调用。
 * 2. 检查文本流、缺失完成事件，以及 failed、incomplete 和 error 的错误分类与服务实际错误信息；挂起流验证总超时/空闲超时及配置时限提示。
 * 3. completed.output 有内容时应优先使用，最终消息正文也优先于暂存文本。
 * 4. 检查网页搜索 URL 引用转为可点击 Markdown 来源，以及输出上限、配置/单次覆盖的思考等级、内置网页搜索和并行工具调用偏好是否正确发出。
 *
 * 只收到部分流不能算成功，必须等 completed。
 */

import { it, expect } from "vitest";
import { createServer } from "node:http";
import { ResponsesProvider } from "../src/providers/responses-provider.js";
import type { Settings } from "../src/shared/types.js";

const settings: Settings = {
  baseUrl: "",
  model: "test",
  maxSteps: 3,
  maxConcurrentTasks: 2,
  commandTimeoutMs: 1000,
  requestTimeoutMs: 3000,
  idleTimeoutMs: 1000,
  maxContextTokens: 300000,
  contextChars: 10000,
  outputChars: 1000,
  logLevel: "info",
};

async function withServer(
  events: unknown[],
  run: (url: string) => Promise<void>,
) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) {
      res.write("data: " + JSON.stringify(event) + "\n\n");
    }

    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };

  try {
    await run("http://127.0.0.1:" + address.port + "/v1");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

it.each([
  {
    requestTimeoutMs: 150,
    idleTimeoutMs: 3000,
    code: "request_timeout",
    detail: "150 ms 总时限",
  },
  {
    requestTimeoutMs: 3000,
    idleTimeoutMs: 150,
    code: "idle_timeout",
    detail: "150 ms 未收到事件",
  },
])(
  "reports configured time limits for $code",
  async ({ requestTimeoutMs, idleTimeoutMs, code, detail }) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const port = (server.address() as { port: number }).port;
      const provider = new ResponsesProvider(
        {
          ...settings,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          requestTimeoutMs,
          idleTimeoutMs,
        },
        "test-key",
      );
      await expect(
        provider.run([], "", [], new AbortController().signal, () => {}),
      ).rejects.toMatchObject({
        code,
        retryable: true,
        message: expect.stringContaining(detail),
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("collects item.done when completed output is empty and preserves function calls", async () => {
  const call = {
    type: "function_call",
    name: "read_file",
    call_id: "a",
    arguments: "{}",
  };

  await withServer(
    [
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { output: [] } },
    ],
    async (baseUrl) => {
      const result = await new ResponsesProvider(
        { ...settings, baseUrl },
        "test-key",
      ).run([], "", [], new AbortController().signal, () => {});

      expect(result.output).toEqual([call]);
    },
  );
});

it("streams text and rejects missing completion", async () => {
  await withServer(
    [{ type: "response.output_text.delta", delta: "hello" }],
    async (baseUrl) => {
      const chunks: string[] = [];

      await expect(
        new ResponsesProvider({ ...settings, baseUrl }, "key").run(
          [],
          "",
          [],
          new AbortController().signal,
          (s) => chunks.push(s),
        ),
      ).rejects.toThrow("未收到完成");
      expect(chunks).toEqual(["hello"]);
    },
  );
});

it("does not treat failed/incomplete events as successful completion", async () => {
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    await withServer([{ type }], async (baseUrl) => {
      await expect(
        new ResponsesProvider({ ...settings, baseUrl }, "key").run(
          [],
          "",
          [],
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("失败或不完整");
    });
  }
});

it("keeps a model service error message while redacting the configured key", async () => {
  await withServer(
    [
      {
        type: "response.failed",
        response: {
          error: {
            code: "invalid_request_error",
            message: "该模型不支持 reasoning；API key actual-api-key 无效。",
          },
        },
      },
    ],
    async (baseUrl) => {
      await expect(
        new ResponsesProvider({ ...settings, baseUrl }, "actual-api-key").run(
          [],
          "",
          [],
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("该模型不支持 reasoning");
      await expect(
        new ResponsesProvider({ ...settings, baseUrl }, "actual-api-key").run(
          [],
          "",
          [],
          new AbortController().signal,
          () => {},
        ),
      ).rejects.not.toThrow("actual-api-key");
    },
  );
});

it("prefers completed output over fallback items and preserves final message text", async () => {
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "final" }],
  };

  await withServer(
    [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          content: [{ type: "output_text", text: "fallback" }],
        },
      },
      { type: "response.completed", response: { output: [message] } },
    ],
    async (baseUrl) => {
      const result = await new ResponsesProvider(
        { ...settings, baseUrl },
        "key",
      ).run([], "", [], new AbortController().signal, () => {});

      expect(result).toEqual({ output: [message], text: "final" });
    },
  );
});

it("renders web search URL citations as deduplicated Markdown sources", async () => {
  const message = {
    type: "message",
    content: [
      {
        type: "output_text",
        text: "OpenAI provides web search.",
        annotations: [
          {
            type: "url_citation",
            title: "OpenAI web search documentation",
            url: "https://platform.openai.com/docs/guides/tools-web-search",
          },
          {
            type: "url_citation",
            title: "Duplicate title is ignored",
            url: "https://platform.openai.com/docs/guides/tools-web-search",
          },
          {
            type: "url_citation",
            title: "Invalid protocol",
            url: "file:///private.txt",
          },
        ],
      },
    ],
  };

  await withServer(
    [{ type: "response.completed", response: { output: [message] } }],
    async (baseUrl) => {
      const result = await new ResponsesProvider(
        { ...settings, baseUrl },
        "key",
      ).run([], "", [], new AbortController().signal, () => {});

      expect(result.text).toBe(
        "OpenAI provides web search.\n\n### Sources\n- [OpenAI web search documentation](<https://platform.openai.com/docs/guides/tools-web-search>)",
      );
    },
  );
});

it("classifies empty completion as retryable and explicit output limit as permanent", async () => {
  for (const [event, code, retryable] of [
    [
      { type: "response.completed", response: { output: [] } },
      "empty_response",
      true,
    ],
    [
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
      "max_output_tokens",
      false,
    ],
  ] as const) {
    await withServer([event], async (baseUrl) => {
      await expect(
        new ResponsesProvider({ ...settings, baseUrl }, "key").run(
          [],
          "",
          [],
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toMatchObject({ code, retryable });
    });
  }
});

it.each([undefined, "low", "medium", "high"] as const)(
  "forwards effort %s, output cap, web search tool, parallel tool preference and parses model metadata",
  async (reasoningEffort) => {
    let requestedLimit: unknown;
    let requestedReasoning: unknown;
    let requestedParallelToolCalls: unknown;
    let requestedTools: unknown;
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: [
              {
                id: "test",
                capabilities: {
                  limits: {
                    max_context_window_tokens: 372000,
                    max_output_tokens: 128000,
                  },
                  tokenizer: "o200k_base",
                },
              },
            ],
          }),
        );

        return;
      }

      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }

      const request = JSON.parse(body);
      requestedLimit = request.max_output_tokens;
      requestedReasoning = request.reasoning;
      requestedParallelToolCalls = request.parallel_tool_calls;
      requestedTools = request.tools;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "ok" }],
                },
              ],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                attribution: { private: "ignored" },
              },
            },
          }) +
          "\n\n",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as { port: number }).port;
      const provider = new ResponsesProvider(
        {
          ...settings,
          reasoningEffort,
          baseUrl: "http://127.0.0.1:" + port + "/v1",
        },
        "key",
      );
      expect(
        (await provider.getCapabilities(new AbortController().signal))?.limits
          .max_context_window_tokens,
      ).toBe(372000);
      const result = await provider.run(
        [],
        "",
        [{ type: "web_search" }],
        new AbortController().signal,
        () => {},
        { maxOutputTokens: 16384 },
      );
      expect(requestedLimit).toBe(16384);
      expect(requestedReasoning).toEqual({ effort: reasoningEffort ?? "high" });
      expect(requestedParallelToolCalls).toBe(true);
      expect(requestedTools).toContainEqual({ type: "web_search" });

      await provider.run([], "", [], new AbortController().signal, () => {}, {
        maxOutputTokens: 256,
        reasoningEffort: "none",
      });
      expect(requestedReasoning).toEqual({ effort: "none" });
      expect(requestedLimit).toBe(256);
      expect(requestedTools).toEqual([]);
      expect(result.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
