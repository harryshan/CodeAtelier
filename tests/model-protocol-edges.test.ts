/**
 * 针对多协议流状态、usage 和辅助路由的边界回归，全部使用临时目录与本机服务。
 * 1. Messages 不得把开始事件的零输出或非法缓存值伪造为最终 usage。
 * 2. 非空开始内容、不合法的工具初始参数和未知块必须失败，不能丢弃后执行工具。
 * 3. Messages 历史保留交错文字/工具顺序；辅助标题使用独立端点/密钥，主任务仍用 Chat。
 * 服务、Engine 和 Store 均在 finally 清理；环境变量逐项恢复，不运行 Evaluation。
 */
import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { createModelProvider } from "../src/providers/create-provider.js";
import { TestEngine, TestStore } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";
import {
  chatFrames,
  messagesFrames,
  withProtocolServer,
} from "./fixtures/protocol-server.js";

afterEach(() => vi.unstubAllEnvs());

async function runMessages(frames: any[]) {
  return withProtocolServer(
    () => ({ frames }),
    async (baseUrl) => {
      const config = new Config(await temp());
      await createModelProvider(
        { ...config.settings, protocol: "messages", baseUrl },
        "fixture-key",
      ).run(
        [{ role: "user", content: "test" }],
        "",
        [],
        new AbortController().signal,
        () => {},
      );
    },
  );
}

it.each(["missing-final", "negative-cache"])(
  "keeps %s Messages usage unknown",
  async (mode) => {
    const frames = messagesFrames();
    if (mode === "missing-final") {
      delete frames.find((frame) => frame.type === "message_delta").usage;
    } else {
      frames[0].message.usage.cache_creation_input_tokens = -1;
    }

    // Capture inside the fixture because its lifetime helper intentionally returns no value.
    await withProtocolServer(
      () => ({ frames }),
      async (baseUrl) => {
        const config = new Config(await temp());
        const result = await createModelProvider(
          { ...config.settings, protocol: "messages", baseUrl },
          "fixture-key",
        ).run(
          [{ role: "user", content: "test" }],
          "",
          [],
          new AbortController().signal,
          () => {},
        );
        expect(result.text).toBe("完成");
        expect(result.usage).toBeUndefined();
      },
    );
  },
);

it.each(["initial-content", "initial-input", "unknown-block"])(
  "rejects Messages %s rather than losing state",
  async (mode) => {
    const frames = messagesFrames("read", [
      { id: "call_a", name: "read_file", args: "{}" },
    ]);
    if (mode === "initial-content") {
      frames[0].message.content = [
        { type: "text", text: "must not be discarded" },
      ];
    } else {
      const start = frames.find(
        (frame) => frame.content_block?.type === "tool_use",
      );
      if (mode === "initial-input") {
        start.content_block.input = { path: "must not be discarded" };
      } else {
        start.content_block.type = "thinking";
      }
    }

    await expect(runMessages(frames)).rejects.toMatchObject({
      retryable: false,
    });
  },
);

it("preserves interleaved Messages text and tool blocks on the next request", async () => {
  await withProtocolServer(
    () => ({ frames: messagesFrames() }),
    async (baseUrl, requests) => {
      const config = new Config(await temp());
      const history = [
        { role: "user", content: "read" },
        {
          type: "function_call",
          call_id: "a",
          name: "read_file",
          arguments: "{}",
        },
        { role: "assistant", content: "between calls" },
        {
          type: "function_call",
          call_id: "b",
          name: "read_file",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "a", output: "first" },
        { type: "function_call_output", call_id: "b", output: "second" },
      ];
      await createModelProvider(
        { ...config.settings, protocol: "messages", baseUrl },
        "fixture-key",
      ).run(history, "", [], new AbortController().signal, () => {});
      expect(
        requests[0].body.messages[1].content.map((block: any) => block.type),
      ).toEqual(["tool_use", "text", "tool_use"]);
      expect(
        requests[0].body.messages[2].content.map(
          (block: any) => block.tool_use_id,
        ),
      ).toEqual(["a", "b"]);
    },
  );
});

it("routes generated titles through the independent auxiliary protocol and key", async () => {
  await withProtocolServer(
    () => ({ frames: messagesFrames("辅助标题") }),
    async (auxiliaryUrl, auxiliaryRequests) => {
      await withProtocolServer(
        () => ({ frames: chatFrames("主模型回复") }),
        async (baseUrl, mainRequests) => {
          vi.stubEnv("CODEATELIER_BASE_URL", baseUrl);
          vi.stubEnv("CODEATELIER_API_PROTOCOL", "chat-completions");
          vi.stubEnv("CODEATELIER_API_KEY", "main-fixture-secret");
          vi.stubEnv("CODEATELIER_AUXILIARY_BASE_URL", auxiliaryUrl);
          vi.stubEnv("CODEATELIER_AUXILIARY_API_PROTOCOL", "messages");
          vi.stubEnv("CODEATELIER_AUXILIARY_MODEL", "aux-fixture");
          vi.stubEnv("CODEATELIER_AUXILIARY_API_KEY", "aux-fixture-secret");
          const config = new Config(await temp());
          const store = new TestStore(
            path.join(config.directory, "history.sqlite"),
          );
          const session = store.create(await temp());
          const engine = new TestEngine(
            store,
            config,
            pino({ enabled: false }),
          );
          try {
            await engine.start(session.id, "测试独立标题模型");
            await engine.active?.done;
            expect(store.tasks(session.id)[0].status).toBe("completed");
            expect(store.get(session.id)?.title).toBe("辅助标题");
            expect(auxiliaryRequests).toHaveLength(1);
            expect(auxiliaryRequests[0].url).toBe("/v1/messages");
            expect(auxiliaryRequests[0].headers["x-api-key"]).toBe(
              "aux-fixture-secret",
            );
            expect(auxiliaryRequests[0].headers.authorization).toBeUndefined();
            expect(mainRequests).toHaveLength(1);
            expect(mainRequests[0].url).toBe("/v1/chat/completions");
            expect(mainRequests[0].headers.authorization).toBe(
              "Bearer main-fixture-secret",
            );
            expect(mainRequests[0].body.model).not.toBe("aux-fixture");
          } finally {
            await engine.close();
            await store.closeAsync();
          }
        },
      );
    },
  );
});
