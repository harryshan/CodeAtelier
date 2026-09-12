/**
 * 文件作用：验证每请求无损整理的可还原性和引擎接入行为。
 * 代码结构：先构造读取记录，再测试重复提取与保守跳过、还原和幂等性，最后覆盖重试后的请求视图及负收益回退。
 */

import { expect, it } from "vitest";
import { mechanicalInput } from "../src/context/mechanical-input.js";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import pino from "pino";
import { ContextManager } from "../src/context/context-manager.js";
import { contextSize } from "../src/context/budget.js";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { ModelError } from "../src/providers/model-error.js";
import { temp } from "./fixtures/helpers.js";

function read(id: string, path: string, text: string) {
  return [
    {
      type: "function_call",
      name: "read_file",
      call_id: id,
      arguments: JSON.stringify({ path }),
    },
    {
      type: "function_call_output",
      call_id: id,
      output: JSON.stringify({ path, text, totalLines: 20 }),
    },
  ];
}

it("factors identical read outputs and file bodies without losing paths, calls, or exact text", () => {
  const text = '精确正文\r\n  spaces and quotes " '.repeat(100);
  const source = [
    ...read("a", "a.ts", text),
    ...read("b", "a.ts", text),
    ...read("c", "c.ts", text),
  ];
  const next = mechanicalInput(source);
  expect(next[1]).toEqual(source[1]);
  expect(JSON.parse(next[3].output).sameOutputAs).toEqual({
    inputIndex: 1,
    callId: "a",
  });
  const body = JSON.parse(next[5].output);
  expect(body.value.path).toBe("c.ts");
  expect(body.sameTextAs).toEqual({
    inputIndex: 1,
    callId: "a",
    field: "text",
  });
  expect(JSON.parse(source[1].output!).text).toBe(text);
  expect(next.filter((item) => item.type === "function_call")).toEqual(
    source.filter((item) => item.type === "function_call"),
  );
  expect(source[3].output).toBe(source[1].output);
  expect(JSON.stringify(next).length).toBeLessThan(
    JSON.stringify(source).length,
  );
});

it("keeps changed versions, errors, truncated records, unknown protocols and ambiguous IDs intact", () => {
  const first = read("a", "a.ts", "x".repeat(2000));
  const changed = read("b", "a.ts", "y".repeat(2000));
  expect(mechanicalInput([...first, ...changed])).toEqual([
    ...first,
    ...changed,
  ]);
  for (const result of [
    { error: "x".repeat(2000) },
    { text: "x".repeat(2000), truncated: true },
  ]) {
    const source = [...read("a", "a", ""), ...read("b", "a", "")];
    source[1].output = JSON.stringify(result);
    source[3].output = JSON.stringify(result);
    expect(mechanicalInput(source)).toEqual(source);
  }

  expect(mechanicalInput([...first, ...first])).toEqual([...first, ...first]);
  const incomplete = [...first, read("b", "a.ts", "x".repeat(2000))[0]];
  expect(mechanicalInput(incomplete)).toEqual(incomplete);
});

it("round trips request references exactly, remains idempotent, and skips noncanonical JSON", () => {
  const source = [
    ...read("a", "a", "body".repeat(1000)),
    ...read("b", "b", "body".repeat(1000)),
    ...read("c", "b", "body".repeat(1000)),
  ];
  const next = mechanicalInput(source);
  const restored: any[] = [];
  for (const item of next) {
    if (item.type !== "function_call_output") {
      restored.push(item);
      continue;
    }

    const encoded = JSON.parse(item.output);
    let output = item.output;
    if (encoded.contextEncoding === "exact-output-v1") {
      output = restored[encoded.sameOutputAs.inputIndex].output;
    } else if (encoded.contextEncoding === "exact-text-v1") {
      encoded.value.text = JSON.parse(
        restored[encoded.sameTextAs.inputIndex].output,
      ).text;
      output = JSON.stringify(encoded.value);
    }

    restored.push({ ...item, output });
  }

  expect(restored).toEqual(source);
  expect(mechanicalInput(next)).toBe(next);
  const noncanonical = source.map((item) =>
    item.output ? { ...item, output: " " + item.output } : item,
  );
  expect(mechanicalInput(noncanonical)).toBe(noncanonical);
  expect(
    mechanicalInput([...read("a", "a", "short"), ...read("b", "a", "short")]),
  ).toEqual([...read("a", "a", "short"), ...read("b", "a", "short")]);
});

it("uses the compact view below threshold on every retry and new tool round while persisting originals", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "db"));
  const root = await temp();
  const session = store.create(root, "mechanical");
  const file = path.join(root, "a.txt");
  const body = "z".repeat(2000);
  await writeFile(file, body);
  const source = [
    { role: "user", content: "original task" },
    ...read("a", file, "1: " + body),
    ...read("b", file, "1: " + body),
  ];
  store.saveContext(session.id, source);
  const requests: any[][] = [];
  const sizes: number[] = [];
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input, instructions, tools) {
      requests.push(structuredClone(input));
      sizes.push(contextSize(input, instructions, tools));
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
    for (const request of requests) {
      expect(JSON.parse(request[4].output).sameOutputAs.inputIndex).toBe(2);
    }

    expect(JSON.parse(requests[2].at(-1).output).sameTextAs.inputIndex).toBe(2);
    expect(store.context(session.id).slice(0, source.length)).toEqual(source);
    expect(store.latestContextSnapshot(session.id)).toBeUndefined();
    const estimates = store
      .events(session.id)
      .filter((event) => event.type === "context_estimate");
    expect(estimates.map((event) => event.data.input)).toEqual(sizes);
    expect(estimates.every((event) => event.data.mechanicalSaved > 0)).toBe(
      true,
    );
  } finally {
    await engine.close();
    store.close();
  }
});

it("rejects mechanical candidates when the selected token measure grows", async () => {
  const store = new Store(path.join(await temp(), "db"));
  const session = store.create(await temp(), "no inflation");
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
    measure: (input) =>
      JSON.stringify(input).includes("exact-output-v1") ? 200 : 100,
  });
  try {
    const input = [
      ...read("a", "a", "x".repeat(2000)),
      ...read("b", "a", "x".repeat(2000)),
    ];
    expect(manager.request(input, "", []).input).toBe(input);
    expect(await manager.prepare(input, "", [])).toBe(input);
  } finally {
    store.close();
  }
});
