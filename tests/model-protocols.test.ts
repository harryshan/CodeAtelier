/**
 * 使用本机 SSE 服务验证新增模型协议的可观察行为，不使用真实模型、凭据或 Evaluation。
 * 1. 两协议共用用例检查真实请求、UTF-8 流文字、多工具往返、usage 和能力限制。
 * 2. 失败矩阵覆盖缺失终止、输出截断、参数损坏、重复调用、HTTP/流错误、取消与超时。
 * 3. 历史转换拒绝未知协议材料和不配对结果；token 锚点随协议变更失效。
 * 4. 生产 Engine 真实创建文件并续聊，验证默认工厂、持久化、搜索裁剪及归档 trace 的协议/首流/关联 ID。
 */
import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { createModelProvider } from "../src/providers/create-provider.js";
import { conversationTurns } from "../src/providers/conversation.js";
import {
  protocolFeatures,
  type ModelProtocol,
} from "../src/providers/protocol.js";
import { tokenScope } from "../src/context/token-anchor.js";
import { auxiliarySettings } from "../src/config/auxiliary-model.js";
import { Config } from "../src/config/config.js";
import { TestEngine, TestStore } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";
import {
  chatFrames,
  messagesFrames,
  withProtocolServer,
} from "./fixtures/protocol-server.js";
import type { Settings } from "../src/shared/types.js";

const protocols = ["chat-completions", "messages"] as const;
const settings: Settings = {
  baseUrl: "",
  model: "fixture-model",
  maxSteps: 3,
  maxConcurrentTasks: 2,
  commandTimeoutMs: 0,
  requestTimeoutMs: 3000,
  idleTimeoutMs: 1000,
  maxContextTokens: 300000,
  contextChars: 10000,
  outputChars: 2000,
  logLevel: "info",
};
const input = [{ role: "user", content: "请处理代码" }];
const tool = {
  type: "function",
  name: "read_file",
  description: "Read",
  parameters: { type: "object", properties: {} },
  strict: true,
};
const calls = [
  { id: "call_a", name: "read_file", args: '{"path":"甲"}' },
  { id: "call_b", name: "read_file", args: '{"path":"乙"}' },
];
const framesFor = (protocol: ModelProtocol) =>
  protocol === "messages" ? messagesFrames : chatFrames;
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllEnvs());

it.each(protocols)(
  "%s streams text and round-trips multiple tool calls with real wire shapes",
  async (protocol) => {
    const frames = framesFor(protocol);
    await withProtocolServer(
      (_request, index) => ({
        frames: index === 0 ? frames("先阅读中文🙂", calls) : frames(),
      }),
      async (baseUrl, requests) => {
        const provider = createModelProvider(
          { ...settings, baseUrl, protocol },
          "fixture-key",
        );
        const deltas: string[] = [];
        let events = 0;
        const result = await provider.run(
          input,
          "遵守权限",
          [tool],
          signal(),
          (delta) => deltas.push(delta),
          {
            maxOutputTokens: 256,
            onStreamEvent: () => {
              events++;
            },
          },
        );
        expect(deltas.join("")).toBe("先阅读中文🙂");
        expect(events).toBeGreaterThan(3);
        expect(result.text).toBe(deltas.join(""));
        expect(result.usage).toEqual({
          input_tokens: 15,
          output_tokens: 5,
          total_tokens: 20,
          input_tokens_details: { cached_tokens: 3 },
        });
        expect(
          result.output.filter((item) => item.type === "function_call"),
        ).toEqual(
          calls.map((call) => ({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.args,
          })),
        );
        const history = [
          ...input,
          ...result.output,
          ...calls.map((call) => ({
            type: "function_call_output",
            call_id: call.id,
            output: "文件内容",
          })),
        ];
        expect(
          (await provider.run(history, "遵守权限", [tool], signal(), () => {}))
            .text,
        ).toBe("完成");
        expect(requests[0].body).not.toHaveProperty("reasoning");
        expect(requests[0].body).not.toHaveProperty("reasoning_effort");
        expect(requests[0].body).not.toHaveProperty("thinking");
        expect(requests[0].body).not.toHaveProperty("input");
        expect(requests[0].body.tools).toHaveLength(1);
        if (protocol === "messages") {
          expect(requests[0].url).toBe("/v1/messages");
          expect(requests[0].headers["x-api-key"]).toBe("fixture-key");
          expect(requests[0].headers.authorization).toBeUndefined();
          expect(requests[0].headers["anthropic-version"]).toBe("2023-06-01");
          expect(requests[0].body.max_tokens).toBe(256);
          expect(requests[0].body.tools[0].input_schema).toEqual(
            tool.parameters,
          );
          expect(requests[1].body.messages.at(-1).content).toEqual(
            calls.map((call) => ({
              type: "tool_result",
              tool_use_id: call.id,
              content: "文件内容",
            })),
          );
          expect(
            requests[1].body.messages
              .at(-2)
              .content.filter((part: any) => part.type === "tool_use"),
          ).toHaveLength(2);
        } else {
          expect(requests[0].url).toBe("/v1/chat/completions");
          expect(requests[0].headers.authorization).toBe("Bearer fixture-key");
          expect(requests[0].body.max_completion_tokens).toBe(256);
          expect(requests[0].body.tools[0].function.parameters).toEqual(
            tool.parameters,
          );
          expect(requests[1].body.messages.at(-3).tool_calls).toHaveLength(2);
          expect(requests[1].body.messages.slice(-2)).toEqual(
            calls.map((call) => ({
              role: "tool",
              tool_call_id: call.id,
              content: "文件内容",
            })),
          );
        }
      },
    );
  },
);

it.each(protocols)(
  "%s rejects truncated streams and malformed tool calls without returning executable output",
  async (protocol) => {
    const frames = framesFor(protocol);
    const cases = [
      { frames: frames("", calls).slice(0, -1), code: "stream_disconnected" },
      {
        frames: frames("", [{ ...calls[0], args: '{"partial":' }]),
        code: "invalid_tool_call",
      },
      {
        frames: frames("", [calls[0], calls[0]]),
        code: protocol === "messages" ? "invalid_stream" : "invalid_tool_call",
      },
      { frames: frames(""), code: "empty_response" },
      {
        frames: frames().map((event) =>
          protocol === "messages" && event.type === "message_delta"
            ? { ...event, delta: { stop_reason: "max_tokens" } }
            : protocol === "chat-completions" &&
                event.choices?.[0]?.finish_reason
              ? { choices: [{ index: 0, delta: {}, finish_reason: "length" }] }
              : event,
        ),
        code: "max_output_tokens",
      },
    ];
    for (const fixture of cases) {
      await withProtocolServer(
        () => ({ frames: fixture.frames }),
        async (baseUrl) => {
          await expect(
            createModelProvider({ ...settings, protocol, baseUrl }, "key").run(
              input,
              "",
              [tool],
              signal(),
              () => {},
            ),
          ).rejects.toMatchObject({ code: fixture.code });
        },
      );
    }
  },
);

it.each(protocols)(
  "%s keeps missing or invalid usage unknown and supports tool-free auxiliary requests",
  async (protocol) => {
    const frames = framesFor(protocol)().map((event) => {
      if (event === "[DONE]") {
        return event;
      }

      const copy = structuredClone(event);
      delete copy.usage;
      if (copy.message) {
        delete copy.message.usage;
      }

      return copy;
    });
    await withProtocolServer(
      () => ({ frames }),
      async (baseUrl, requests) => {
        const result = await createModelProvider(
          { ...settings, protocol, baseUrl },
          "key",
        ).run(input, "分类", [], signal(), () => {}, {
          maxOutputTokens: 256,
          reasoningEffort: "none",
        });
        expect(result.usage).toBeUndefined();
        expect(requests[0].body.tools).toBeUndefined();
        expect(result.text).toBe("完成");
      },
    );
  },
);

it.each(protocols)(
  "%s classifies HTTP errors without leaking keys or retrying locally",
  async (protocol) => {
    for (const status of [401, 429, 500]) {
      await withProtocolServer(
        () => ({
          status,
          raw: JSON.stringify({ error: { message: "failed fixture-secret" } }),
        }),
        async (baseUrl, requests) => {
          const error = await createModelProvider(
            { ...settings, protocol, baseUrl },
            "fixture-secret",
          )
            .run(input, "", [], signal(), () => {})
            .catch((value) => value);
          expect(error).toMatchObject({
            status,
            retryable: status !== 401,
            code: `http_${status}`,
          });
          expect(error.message).not.toContain("fixture-secret");
          expect(requests).toHaveLength(1);
        },
      );
    }
  },
);

it.each(protocols)(
  "%s releases hanging streams on cancellation and both time limits",
  async (protocol) => {
    for (const mode of ["cancel", "idle_timeout", "request_timeout"]) {
      await withProtocolServer(
        () => ({ hang: true }),
        async (baseUrl, requests) => {
          const controller = new AbortController();
          const provider = createModelProvider(
            {
              ...settings,
              protocol,
              baseUrl,
              idleTimeoutMs: mode === "idle_timeout" ? 100 : 3000,
              requestTimeoutMs: mode === "request_timeout" ? 100 : 3000,
            },
            "key",
          );
          const promise = provider
            .run(input, "", [], controller.signal, () => {})
            .catch((error) => error);
          if (mode === "cancel") {
            await vi.waitFor(() => expect(requests).toHaveLength(1));
            controller.abort(new Error("user cancelled"));
            expect((await promise).message).toBe("user cancelled");
          } else {
            expect(await promise).toMatchObject({
              code: mode,
              retryable: true,
            });
          }
        },
      );
    }
  },
);

it("rejects unknown history and unmatched results instead of dropping protocol state", () => {
  expect(() =>
    conversationTurns([{ type: "reasoning", encrypted_content: "opaque" }]),
  ).toThrow();
  expect(() =>
    conversationTurns([
      { type: "function_call_output", call_id: "unknown", output: "result" },
    ]),
  ).toThrow();
  expect(() =>
    conversationTurns([
      {
        type: "function_call",
        call_id: "pending",
        name: "read_file",
        arguments: "{}",
      },
    ]),
  ).toThrow();
  expect(tokenScope(settings)).not.toBe(
    tokenScope({ ...settings, protocol: "messages" }),
  );
  expect(protocolFeatures("messages").webSearch).toBe(false);
  expect(
    auxiliarySettings({
      ...settings,
      protocol: "chat-completions",
      auxiliaryModel: "small",
      auxiliaryProtocol: "messages",
      auxiliaryBaseUrl: "https://aux.example.test/v1",
    }),
  ).toMatchObject({
    protocol: "messages",
    baseUrl: "https://aux.example.test/v1",
    model: "small",
  });
});

it.each(protocols)(
  "%s rejects unsupported tools before any network request",
  async (protocol) => {
    await expect(
      createModelProvider({ ...settings, protocol }, "key").run(
        input,
        "",
        [{ type: "web_search" }],
        signal(),
        () => {},
      ),
    ).rejects.toMatchObject({ code: "unsupported_tool" });
  },
);

it.each(protocols)(
  "%s drives the production Engine through file edits, persistence and continuation",
  async (protocol) => {
    const edits = ["a", "b"].map((id) => ({
      id: `call_${id}`,
      name: "edit_files",
      args: JSON.stringify({
        execution: { id, dependsOn: [] },
        arguments: {
          files: [
            { path: `${id}.txt`, create: true, content: `created ${id}` },
          ],
        },
      }),
    }));
    const frames = framesFor(protocol);
    await withProtocolServer(
      (_request, index) => ({
        frames: index === 0 ? frames("创建文件", edits) : frames(),
      }),
      async (baseUrl, requests) => {
        vi.stubEnv("CODEATELIER_BASE_URL", baseUrl);
        vi.stubEnv("CODEATELIER_API_PROTOCOL", protocol);
        vi.stubEnv("CODEATELIER_API_KEY", "fixture-key");
        const config = new Config(await temp());
        const store = new TestStore(
          path.join(config.directory, "history.sqlite"),
        );
        const root = await temp();
        const session = store.create(root, "protocol test");
        const engine = new TestEngine(store, config, pino({ enabled: false }));
        try {
          const task = await engine.start(session.id, "创建 a 和 b");
          await engine.active?.done;
          expect(store.tasks(session.id)[0]).toMatchObject({
            status: "completed",
          });
          expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
            "created a",
          );
          expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe(
            "created b",
          );
          expect(
            store
              .context(session.id)
              .filter((item) => item.type === "function_call_output"),
          ).toHaveLength(2);
          expect(
            requests[0].body.tools.every(
              (entry: any) => entry.type !== "web_search",
            ),
          ).toBe(true);
          const trace = JSON.parse((await engine.savedTrace(task))!);
          const modelSpans = trace.traceEvents.filter(
            (event: any) => event.name === "llm.request" && event.ph === "b",
          );
          expect(modelSpans).toHaveLength(2);
          expect(
            modelSpans.every(
              (event: any) =>
                event.args.protocol === protocol &&
                event.args.status === "ok" &&
                event.args.requestId,
            ),
          ).toBe(true);
          expect(
            trace.traceEvents.some(
              (event: any) => event.name === "llm.first_event",
            ),
          ).toBe(true);
          expect(JSON.stringify(trace)).not.toContain("fixture-key");
          await engine.start(session.id, "继续说明");
          await engine.active?.done;
          expect(
            store
              .tasks(session.id)
              .every((task) => task.status === "completed"),
          ).toBe(true);
          expect(requests).toHaveLength(3);
        } finally {
          await engine.close();
          await store.closeAsync();
        }
      },
    );
  },
);
