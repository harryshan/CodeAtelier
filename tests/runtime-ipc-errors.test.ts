/**
 * 用内存双向流验证 Runtime IPC 错误确实传到调用方，不依赖安装态 Sandbox 或真实模型。
 *
 * 1. exchange 为每次请求创建 peer 并在 finally 中关闭连接。
 * 2. handler 错误保留操作、原因和重试元数据；凭据、任意对象正文不进入响应，长文本有界。
 * 3. 本地 schema 拒绝指出操作及校验字段，不能回显请求值。
 */

import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { ModelError } from "../src/providers/model-error.js";
import { RuntimeIpcPeer } from "../src/sandbox/runtime-ipc-peer.js";

async function exchange(error: unknown) {
  const outgoing = new PassThrough();
  const incoming = new PassThrough();
  const broker = new RuntimeIpcPeer({
    input: outgoing,
    output: incoming,
    getErrorSecrets: () => ["private-key"],
    handleRequest: async () => {
      throw error;
    },
  });
  const runtime = new RuntimeIpcPeer({ input: incoming, output: outgoing });

  try {
    return await runtime
      .request(
        "model_run",
        {
          purpose: "task",
          input: [],
          instructions: "",
          tools: [],
        },
        new AbortController().signal,
      )
      .then(
        () => {
          throw new Error("Expected IPC failure");
        },
        (failure: Error) => failure,
      );
  } finally {
    runtime.end();
    broker.end();
  }
}

it("preserves timeout and HTTP failure details across IPC", async () => {
  const timeout = await exchange(
    new ModelError(
      "模型请求超过 300000 ms 总时限，未收到完成事件。",
      true,
      "request_timeout",
    ),
  );
  expect(timeout).toMatchObject({ code: "request_timeout", retryable: true });
  expect(timeout.message).toContain("model_run");
  expect(timeout.message).toContain("300000 ms");

  const http = await exchange(
    new ModelError(
      "模型服务 HTTP 429：服务繁忙",
      true,
      "http_429",
      429,
      2000,
      "req-123",
    ),
  );
  expect(http).toMatchObject({
    status: 429,
    retryAfterMs: 2000,
    providerRequestId: "req-123",
    retryable: true,
  });
  expect(http.message).toContain("服务繁忙");
  expect(http.message).toContain("http_429");
});

it("redacts and bounds actual causes without serializing error bodies", async () => {
  const failure = await exchange(
    Object.assign(
      new Error("存储提交失败 private-key", {
        cause: new Error("SQLITE_BUSY token=hidden"),
      }),
      { body: "private source body" },
    ),
  );
  expect(failure.message).toContain("存储提交失败");
  expect(failure.message).toContain("SQLITE_BUSY");
  expect(failure.message).not.toMatch(/private-key|hidden|private source body/);
  const long = await exchange(new Error("x".repeat(5000)));
  expect(long.message.length).toBeLessThanOrEqual(1000);
  expect(long.message).toContain("截断");
  const unknown = await exchange({ body: "private source body" });
  expect(unknown.message).toContain("未提供错误详情");
  expect(unknown.message).toContain("model_run");
  expect(unknown.message).not.toContain("private source body");
});

it("identifies invalid request fields without echoing request values", async () => {
  const peer = new RuntimeIpcPeer({
    input: new PassThrough(),
    output: new PassThrough(),
  });
  try {
    await expect(
      peer.request(
        "model_run",
        { purpose: "private-prompt" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/model_run.*body/);
    await expect(
      peer.request(
        "model_run",
        { purpose: "private-prompt" },
        new AbortController().signal,
      ),
    ).rejects.not.toThrow("private-prompt");
  } finally {
    peer.end();
  }
});
