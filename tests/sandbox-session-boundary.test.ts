/**
 * 验证 Agent Runtime 经 Broker 写入压缩快照时仍受认证 session 边界约束。
 * 测试使用临时 SQLite Store，不启动 Windows Runtime、Named Pipe、账户或原生 Sandbox。
 *
 * 1. runtime IPC schema 拒绝字段不完整的任意 snapshot，防止 unknown 直达 Store。
 * 2. 较长摘要说明可通过 IPC schema 并完整保存，不受旧的 20000 字符阈值拒绝。
 * 3. Store 以 Broker 传入的目标 session 为权威，拒绝 snapshot.sessionId 指向其它会话。
 * 4. parentId 必须能在同一会话中读取；拒绝后快照和活动上下文都保持不变。
 */

import path from "node:path";
import { expect, it } from "vitest";
import type { ContextSnapshot } from "../src/context/types.js";
import { runtimeRequestSchema } from "../src/sandbox/runtime-ipc-protocol.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

function snapshot(sessionId: string, id: string): ContextSnapshot {
  return {
    version: 1,
    id,
    sessionId,
    parentId: null,
    sourceHash: "a".repeat(64),
    model: "test-model",
    createdAt: new Date(0).toISOString(),
    beforeChars: 10,
    afterChars: 5,
    cut: 1,
    source: [{ role: "user", content: "source" }],
    summaries: [],
    ledger: [],
  };
}

it("validates compact snapshots before accepting an IPC request", () => {
  expect(() =>
    runtimeRequestSchema.parse({
      type: "request",
      requestId: "request-1",
      operation: "session_compact",
      body: { snapshot: { sessionId: "other" }, input: [] },
    }),
  ).toThrow();
});

it("accepts and persists a compaction note beyond the old fixed limit", async () => {
  const store = new Store(path.join(await temp(), "history.sqlite"));
  const session = store.create(await temp(), "context");
  const note = "历史摘要与执行账本。".repeat(2_500);
  const compacted = snapshot(session.id, "long-note");
  const input = [
    { role: "user", content: "continue" },
    { role: "assistant", content: note },
  ];
  compacted.note = note;

  try {
    expect(note.length).toBeGreaterThan(20_000);
    expect(
      runtimeRequestSchema.safeParse({
        type: "request",
        requestId: "long-note-request",
        operation: "session_compact",
        body: { snapshot: compacted, input },
      }).success,
    ).toBe(true);

    await store.compactContextAsync(session.id, compacted, input);
    expect(store.latestContextSnapshot(session.id)?.note).toBe(note);
    expect(store.context(session.id)).toEqual(input);
  } finally {
    store.close();
  }
});

it("cannot compact another session or attach a foreign parent snapshot", async () => {
  const store = new Store(path.join(await temp(), "history.sqlite"));
  const first = store.create(await temp(), "first");
  const second = store.create(await temp(), "second");
  store.saveContext(first.id, [{ role: "user", content: "first-original" }]);
  store.saveContext(second.id, [{ role: "user", content: "second-original" }]);

  try {
    await expect(
      store.compactContextAsync(
        first.id,
        snapshot(second.id, "foreign-snapshot"),
        [{ role: "assistant", content: "changed" }],
      ),
    ).rejects.toThrow("不属于目标会话");
    expect(store.context(first.id)).toEqual([
      { role: "user", content: "first-original" },
    ]);
    expect(store.context(second.id)).toEqual([
      { role: "user", content: "second-original" },
    ]);

    await store.compactContextAsync(
      second.id,
      snapshot(second.id, "second-parent"),
      [{ role: "user", content: "second-compacted" }],
    );
    const child = {
      ...snapshot(first.id, "first-child"),
      parentId: "second-parent",
    };
    await expect(
      store.compactContextAsync(first.id, child, []),
    ).rejects.toThrow("父快照不属于目标会话");
    expect(store.latestContextSnapshot(first.id)).toBeUndefined();
  } finally {
    store.close();
  }
});
