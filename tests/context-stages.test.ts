/**
 * 文件作用：验证三级压缩的完整来源覆盖和逐级停止行为。
 *
 * 使用场景与输入输出：
 * 使用受控历史、模拟摘要提供商与临时 Store，观察 ContextManager 选择的阶段和保留材料。
 *
 * 代码结构与阅读顺序：
 * 1. 先验证长记录分块覆盖每个字符，包含正文中间的失败信息。
 * 2. setup 构造可触发压缩的会话，去重用例检查无模型调用且协议配对完整。
 * 3. 归档用例验证诊断摘录和后续摘要前的全文展开。
 * 4. 边界用例保留不同文件版本、失败或未知结果，以及已有可核对摘要及来源。
 *
 * 维护注意事项：
 * 压缩效果不能以丢失中间证据换取；去重与归档是否成功由快照和结果内容判断。
 */

import { expect, it } from "vitest";
import { summaryChunks } from "../src/context/compactor.js";
import path from "node:path";
import { ContextManager } from "../src/context/context-manager.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";
import { projectReads } from "../src/context/read-projection.js";
import { contextSize } from "../src/context/budget.js";

it("sends every character of long records to the summarizer, including middle failures", () => {
  const source = [
    {
      role: "assistant",
      content: "a".repeat(9000) + "CRITICAL middle failure" + "b".repeat(9000),
    },
  ];
  let measurements = 0;
  const records = summaryChunks(source, 12000, (...args) => {
    measurements++;

    return contextSize(...args);
  }).flatMap((chunk) => JSON.parse(chunk[0].content));
  expect(records.map((record) => record.excerpt).join("")).toBe(
    JSON.stringify(source[0]),
  );
  expect(records.every((record) => record.omitted === false)).toBe(true);
  expect(measurements).toBeLessThan(10);
});

async function setup() {
  const store = new Store(path.join(await temp(), "stages.db"));
  const session = store.create(await temp(), "stages");
  const requests: any[][] = [];
  const manager = new ContextManager({
    store,
    sessionId: session.id,
    model: "test",
    limit: 12000,
    signal: new AbortController().signal,
    clean: (text) => text,
    notice: () => {},
    report: () => {},
    provider: {
      async run(input) {
        const records = JSON.parse(input[0].content);
        requests.push(records);

        return {
          output: [],
          text: JSON.stringify({
            completed: [],
            conclusions: [],
            verification: [],
            pending: [
              {
                text: "Keep the outstanding migration blocker",
                sources: [records[0].index],
              },
            ],
          }),
        };
      },
    },
  });
  const read = (id: string, text: string, file = "a.ts") => {
    const result = { path: file, totalLines: 100, text };
    store.event(session.id, "task", "tool_result", {
      callId: id,
      name: "read_file",
      result,
    });

    return [
      {
        type: "function_call",
        call_id: id,
        name: "read_file",
        arguments: JSON.stringify({ path: file }),
      },
      {
        type: "function_call_output",
        call_id: id,
        output: JSON.stringify(result),
      },
    ];
  };

  return { store, session, requests, manager, read };
}

it("deduplicates identical historical reads without model calls and preserves protocol pairs", async () => {
  const f = await setup();
  try {
    const source = [
      { role: "user", content: "task" },
      ...f.read("a", "x".repeat(3000)),
      ...f.read("b", "x".repeat(3000)),
      ...f.read("c", "x".repeat(3000)),
      ...f.read("d", "x".repeat(3000)),
      { role: "user", content: "next" },
    ];
    const next = await f.manager.prepare(source, "", []);
    const request = f.manager.request(next, "", []);
    expect(f.store.latestContextSnapshot(f.session.id)).toBeUndefined();
    expect(next).toBe(source);
    expect(f.requests).toHaveLength(0);
    expect(next.map((item) => item.call_id)).toEqual(
      source.map((item) => ("call_id" in item ? item.call_id : undefined)),
    );
    expect(contextSize(request.input, "", [])).toBeLessThan(7200);
    expect(request.after).toBeLessThan(request.before);
  } finally {
    f.store.close();
  }
});

it("archives large reads, retains middle diagnostics, and expands full records on later summarization", async () => {
  const f = await setup();
  try {
    const full =
      "a".repeat(8000) + "\nFAILURE migration pending\n" + "b".repeat(8000);
    const source = [
      { role: "user", content: "keep interface" },
      ...f.read("a", full),
      { role: "user", content: "next" },
    ];
    const first = await f.manager.prepare(source, "", []);
    expect(f.store.latestContextSnapshot(f.session.id)!.stage).toBe("archive");
    expect(f.requests).toHaveLength(0);
    expect(JSON.stringify(first)).toContain("FAILURE migration pending");
    await f.manager.prepare(
      [
        ...first,
        { role: "assistant", content: "z".repeat(14000) },
        { role: "user", content: "again" },
      ],
      "",
      [],
    );
    expect(f.store.latestContextSnapshot(f.session.id)!.stage).toBe("summary");
    expect(
      f.store
        .latestContextSnapshot(f.session.id)!
        .ledger.every((record) => record.status === "recorded"),
    ).toBe(true);
    const parts = f.requests.flat().filter((record) => record.index === 2);
    expect(parts.map((record) => record.excerpt).join("")).toBe(
      JSON.stringify(source[2]),
    );
  } finally {
    f.store.close();
  }
});

it("does not deduplicate different file versions or project unknown, failed, and command results", async () => {
  const f = await setup();
  try {
    const different = [
      ...f.read("a", "a".repeat(3000)),
      ...f.read("b", "b".repeat(3000)),
    ];
    expect(
      projectReads(
        different,
        "snapshot",
        f.store.events(f.session.id),
        "deduplicate",
      ),
    ).toEqual(different);
    const unknown = f.read("unknown", "x".repeat(3000));
    expect(projectReads(unknown, "snapshot", [], "archive")).toEqual(unknown);
    const command = unknown.map((item) =>
      item.name ? { ...item, name: "run_command" } : item,
    );
    expect(
      projectReads(
        command,
        "snapshot",
        f.store.events(f.session.id),
        "archive",
      ),
    ).toEqual(command);
    const result = { text: "x".repeat(3000), error: "failed" };
    const failed = [
      { type: "function_call", call_id: "bad", name: "read_file" },
      {
        type: "function_call_output",
        call_id: "bad",
        output: JSON.stringify(result),
      },
    ];
    f.store.event(f.session.id, "task", "tool_result", {
      callId: "bad",
      name: "read_file",
      result,
    });
    expect(
      projectReads(failed, "snapshot", f.store.events(f.session.id), "archive"),
    ).toEqual(failed);
  } finally {
    f.store.close();
  }
});

it("retains prior verified summary text and its source IDs without summarizing it again", async () => {
  const f = await setup();
  try {
    const first = await f.manager.prepare(
      [
        { role: "user", content: "task" },
        { role: "assistant", content: "x".repeat(16000) },
        { role: "user", content: "next" },
      ],
      "",
      [],
    );
    const prior = f.store.latestContextSnapshot(f.session.id)!;
    const firstCalls = f.requests.length;
    const second = await f.manager.prepare(
      [
        ...first,
        { role: "assistant", content: "y".repeat(15000) },
        { role: "user", content: "again" },
      ],
      "",
      [],
    );
    expect(second).toContainEqual({ role: "assistant", content: prior.note });
    expect(JSON.stringify(f.requests.slice(firstCalls))).not.toContain(
      prior.id,
    );
    expect(f.store.contextSnapshot(f.session.id, prior.id)).toEqual(prior);
  } finally {
    f.store.close();
  }
});
