/**
 * 文件作用：验证 Responses 流事件适配和请求参数传递。
 * 代码结构：先定义设置与本机 SSE 模拟服务，再覆盖结果回收、未完成及失败流、最终输出优先级、错误分类和思考等级。
 */

import { it, expect } from "vitest";
import { createServer } from "node:http";
import { ResponsesProvider } from "../src/providers/responses-provider.js";
import type { Settings } from "../src/shared/types.js";

const settings: Settings = {
  baseUrl: "",
  model: "test",
  maxSteps: 3,
  commandTimeoutMs: 1000,
  requestTimeoutMs: 3000,
  idleTimeoutMs: 1000,
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
  "forwards effort %s, output cap and parses model metadata",
  async (reasoningEffort) => {
    let requestedLimit: unknown;
    let requestedReasoning: unknown;
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

      requestedLimit = JSON.parse(body).max_output_tokens;
      requestedReasoning = JSON.parse(body).reasoning;
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
        [],
        new AbortController().signal,
        () => {},
        { maxOutputTokens: 16384 },
      );
      expect(requestedLimit).toBe(16384);
      expect(requestedReasoning).toEqual({ effort: reasoningEffort ?? "high" });
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
