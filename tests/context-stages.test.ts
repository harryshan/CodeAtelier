/**
 * 检查上下文默认直接摘要、旧投影兼容性和原始记录的完整回读。
 * 用模拟历史、摘要模型和临时 Store 驱动 ContextManager，读取快照核对结果。
 *
 * 1. 检查长记录分块后能覆盖每个字符，包括中间的失败信息。
 * 2. setup 创建长历史会话；重复读取用例确认默认不走去重或归档，模型接收全文。
 * 3. 长读取用例检查摘要请求覆盖中间诊断，旧投影快照仍可在直接摘要前展开全文。
 * 4. 检查不同文件版本、失败和未知结果、已有摘要及来源都能保留。
 *
 * 不能通过丢掉正文中间的内容来让压缩“通过”。
 */

import { expect, it } from "vitest";
import { summaryChunks } from "../src/context/compactor.js";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ContextSnapshot } from "../src/context/types.js";
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

it("summarizes repeated reads directly without first projecting tool outputs", async () => {
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
    const snapshot = f.store.latestContextSnapshot(f.session.id)!;
    expect(snapshot.stage).toBe("summary");
    expect(snapshot.source).toEqual(source);
    expect(snapshot.projections).toBeUndefined();
    expect(f.requests.length).toBeGreaterThan(0);
    for (const index of [2, 4, 6, 8]) {
      const excerpts = f.requests
        .flat()
        .filter((record) => record.index === index)
        .map((record) => record.excerpt);
      expect(excerpts.join("")).toBe(JSON.stringify(source[index]));
    }

    expect(request.input).toBe(next);
    expect(request.after).toBe(request.before);
    expect(contextSize(next, "", [])).toBeLessThan(7200);
  } finally {
    f.store.close();
  }
});

it("summarizes long read results with middle diagnostics without an archive stage", async () => {
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
    const snapshot = f.store.latestContextSnapshot(f.session.id)!;
    expect(snapshot.stage).toBe("summary");
    expect(snapshot.source).toEqual(source);
    expect(snapshot.projections).toBeUndefined();
    expect(first).not.toEqual(source);
    expect(
      snapshot.ledger.every((record) => record.status === "recorded"),
    ).toBe(true);
    const parts = f.requests.flat().filter((record) => record.index === 2);
    expect(parts.map((record) => record.excerpt).join("")).toBe(
      JSON.stringify(source[2]),
    );
  } finally {
    f.store.close();
  }
});

it("expands old archive snapshots before directly summarizing the full read", async () => {
  const f = await setup();
  try {
    const source = [
      { role: "user", content: "keep the old read" },
      ...f.read("old", "a".repeat(9000) + "MIDDLE FAILURE" + "b".repeat(9000)),
      { role: "user", content: "next" },
    ];
    const id = "legacy-archive";
    const projected = projectReads(
      source,
      id,
      f.store.events(f.session.id),
      "archive",
    );
    expect(projected[2]).not.toEqual(source[2]);

    const previous: ContextSnapshot = {
      version: 1,
      stage: "archive",
      id,
      sessionId: f.session.id,
      parentId: null,
      sourceHash: createHash("sha256")
        .update(JSON.stringify(source))
        .digest("hex"),
      model: "test",
      createdAt: new Date().toISOString(),
      beforeChars: contextSize(source, "", []),
      afterChars: contextSize(projected, "", []),
      cut: 3,
      source,
      projections: [{ index: 2, output: projected[2].output }],
      summaries: [],
      ledger: [],
    };
    await f.store.compactContextAsync(f.session.id, previous, projected);

    const input = [
      ...projected,
      { role: "assistant", content: "z".repeat(14000) },
      { role: "user", content: "again" },
    ];
    await f.manager.prepare(input, "", []);
    const snapshot = f.store.latestContextSnapshot(f.session.id)!;
    expect(snapshot.stage).toBe("summary");
    expect(snapshot.parentId).toBe(id);
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
