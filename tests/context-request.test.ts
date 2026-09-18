/**
 * 验证未触发有损压缩时，模型请求直接使用完整的已保存上下文。
 * ContextManager 用临时 Store 检查预算计量；Engine 与模拟模型检查重试及工具后续轮次。
 *
 * 1. read 构造重复文件读取的协议调用与结果，确保测试会捕获旧的请求引用转换。
 * 2. 第一项核对 request 与 prepare 不改写历史，且本地计量与原始输入一致。
 * 3. 第二项核对瞬态重试、工具结果回传和 Store 中的历史均保留完整正文。
 *
 * 测试不连接真实模型或运行 Evaluation；文件读取只发生在临时工作区。
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { contextSize } from "../src/context/budget.js";
import { ContextManager } from "../src/context/context-manager.js";
import { ModelError } from "../src/providers/model-error.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

function read(id: string, file: string, text: string) {
  return [
    {
      type: "function_call",
      name: "read_file",
      call_id: id,
      arguments: JSON.stringify({ path: file }),
    },
    {
      type: "function_call_output",
      call_id: id,
      output: JSON.stringify({ path: file, text, totalLines: 20 }),
    },
  ];
}

it("measures and sends unchanged history below the compaction threshold", async () => {
  const store = new Store(path.join(await temp(), "db"));
  const session = store.create(await temp(), "full context");
  const manager = new ContextManager({
    store,
    sessionId: session.id,
    model: "test",
    limit: 100000,
    signal: new AbortController().signal,
    clean: (text) => text,
    notice: () => {},
    report: () => {},
    provider: {
      async run() {
        throw new Error("must not summarize");
      },
    },
  });

  try {
    const input = [
      { role: "user", content: "read the file" },
      ...read("a", "a.ts", "x".repeat(2000)),
      ...read("b", "a.ts", "x".repeat(2000)),
    ];
    const prepared = await manager.prepare(input, "rules", []);
    const request = manager.request(prepared, "rules", []);

    expect(prepared).toBe(input);
    expect(request.input).toBe(input);
    expect(request.before).toBe(contextSize(input, "rules", []));
    expect(request.after).toBe(request.before);
    expect(store.latestContextSnapshot(session.id)).toBeUndefined();
  } finally {
    store.close();
  }
});

it("keeps duplicate read results intact on retries and later tool rounds", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "db"));
  const root = await temp();
  const session = store.create(root, "full requests");
  const file = path.join(root, "a.txt");
  const body = "z".repeat(2000);
  await writeFile(file, body);

  const original = [
    { role: "user", content: "original task" },
    ...read("a", file, "1: " + body),
    ...read("b", file, "1: " + body),
  ];
  store.saveContext(session.id, original);

  const requests: any[][] = [];
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input) {
      requests.push(structuredClone(input));
      if (requests.length === 1) {
        throw new ModelError("temporary", true, "stream_disconnected");
      }

      if (requests.length === 2) {
        return {
          output: [
            {
              type: "function_call",
              name: "read_file",
              call_id: "c",
              arguments: JSON.stringify({
                path: "a.txt",
                startLine: 1,
                endLine: 20,
              }),
            },
          ],
          text: "",
        };
      }

      return { output: [{ role: "assistant", content: "done" }], text: "done" };
    },
  }));

  try {
    engine.start(session.id, "continue");
    await engine.active?.done;

    expect(store.tasks(session.id)[0].status).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].slice(0, original.length)).toEqual(original);
    expect(requests[2].slice(0, original.length)).toEqual(original);
    expect(JSON.parse(requests[2].at(-1).output).text).toContain(body);
    expect(store.context(session.id).slice(0, original.length)).toEqual(
      original,
    );
    expect(store.latestContextSnapshot(session.id)).toBeUndefined();
  } finally {
    await engine.close();
    store.close();
  }
});
