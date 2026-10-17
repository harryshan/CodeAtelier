/**
 * 验证主/子模型的缓存分组绑定，不调用真实模型或读取用户配置。
 *
 * 1. 使用共享模拟 provider 交叉请求，核对会话、子任务命名空间、包装器重建及重试的 key 稳定性。
 * 2. 检查绑定不改变输入、工具、流回调和输出上限，不修改调用方选项或泄露原始身份。
 * 3. Chat Completions/Messages 原样返回；失败/取消原样传播，不在包装器内发起隐式重试。
 * 4. tracing 及简洁投影只保留 key 指纹和服务实报缓存数，缺少 usage 时不补零。
 */

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { withPromptCacheKey } from "../src/providers/prompt-cache.js";
import { tracedModelProvider } from "../src/tracing/model-provider.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { simplifyTrace } from "../src/tracing/simple-view.js";

it("keeps keys stable across interleaved requests and separates agent identities", async () => {
  const keys: string[] = [];
  const input = [{ role: "user", content: "private input" }];
  const tools = [{ type: "web_search" }];
  const signal = new AbortController().signal;
  const deltas: string[] = [];
  const options = { maxOutputTokens: 256, reasoningEffort: "low" as const };
  const provider: ModelProvider = {
    protocol: "responses",
    async run(
      actualInput,
      instructions,
      actualTools,
      actualSignal,
      onDelta,
      actualOptions,
    ) {
      expect(actualInput).toBe(input);
      expect(instructions).toBe("instructions");
      expect(actualTools).toBe(tools);
      expect(actualSignal).toBe(signal);
      expect(actualOptions).toMatchObject(options);
      keys.push(actualOptions!.promptCacheKey!);
      onDelta("ok");

      return { text: "ok", output: [] };
    },
  };
  const call = (sessionId: string, taskId?: string, subagentId = "child") =>
    withPromptCacheKey(
      provider,
      sessionId,
      taskId ? { taskId, subagentId } : undefined,
    ).run(
      input,
      "instructions",
      tools,
      signal,
      (text) => deltas.push(text),
      options,
    );

  await call("session-secret");
  await call("session-secret", "task-1");
  await call("session-secret");
  await call("session-secret", "task-1");
  await call("session-secret", "task-1", "other-child");
  await call("session-secret", "task-2");
  await call("other-session");
  expect(keys[0]).toBe(keys[2]);
  expect(keys[1]).toBe(keys[3]);
  expect(new Set(keys).size).toBe(5);
  expect(keys.every((key) => /^ca1_[a-f0-9]{48}$/.test(key))).toBe(true);
  expect(JSON.stringify(keys)).not.toContain("session-secret");
  expect(options).not.toHaveProperty("promptCacheKey");
  expect(deltas).toHaveLength(7);
});

it.each(["chat-completions", "messages"] as const)(
  "leaves %s unchanged",
  (protocol) => {
    const provider: ModelProvider = {
      protocol,
      run: async () => ({ output: [], text: "ok" }),
    };

    expect(withPromptCacheKey(provider, "session")).toBe(provider);
  },
);

it.each([false, true])(
  "propagates failure with aborted=%s and keeps the key on caller retry",
  async (aborted) => {
    const failure = new Error("test failure");
    const controller = new AbortController();
    const keys: Array<string | undefined> = [];
    const provider: ModelProvider = {
      async run(_input, _instructions, _tools, signal, _onDelta, options) {
        keys.push(options?.promptCacheKey);
        signal.throwIfAborted();
        throw failure;
      },
    };
    if (aborted) {
      controller.abort(failure);
    }

    const bound = withPromptCacheKey(provider, "session");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        bound.run([], "", [], controller.signal, () => {}),
      ).rejects.toBe(failure);
    }

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  },
);

it.each([true, false])(
  "exports cache fingerprints with reported usage=%s",
  async (reportedUsage) => {
    const recorder = new TraceRecorder();
    recorder.startTask("task", "session");
    const rawKey = "private-cache-routing-value";
    const provider = tracedModelProvider(
      {
        protocol: "responses",
        run: async () => ({
          output: [],
          text: "ok",
          ...(reportedUsage
            ? {
                usage: {
                  input_tokens: 4096,
                  output_tokens: 1,
                  total_tokens: 4097,
                  input_tokens_details: { cached_tokens: 3072 },
                },
              }
            : {}),
        }),
      },
      recorder,
      {
        taskId: "task",
        purpose: "subagent",
        subagentId: "child",
        model: "test",
      },
    );

    await provider.run([], "", [], new AbortController().signal, () => {}, {
      promptCacheKey: rawKey,
    });
    recorder.finishTask("task", "ok");
    const exported = recorder.exportTask("task");
    const serialized = JSON.stringify(exported);
    const simple = simplifyTrace(serialized);
    const model = simple.traceEvents.find(
      (event) =>
        event.ph === "X" &&
        (event.args as Record<string, unknown> | undefined)?.operation ===
          "llm.request",
    );

    const modelArgs = model?.args as Record<string, unknown> | undefined;

    expect(serialized).not.toContain(rawKey);
    expect(modelArgs).toMatchObject({
      subagentId: "child",
      promptCacheKeyHash: createHash("sha256").update(rawKey).digest("hex"),
    });
    expect(modelArgs?.cachedInputTokens).toBe(reportedUsage ? 3072 : undefined);
  },
);
