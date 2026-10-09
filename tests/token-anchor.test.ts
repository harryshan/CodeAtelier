/**
 * 验证跨任务实报锚点的预算、持久化和传输边界，不请求真实模型或使用用户历史。
 *
 * 1. 固定容量和真实 tokenizer 核对 JSON 重建、仅追加编码、指令增长/缩短，以及模型/工具/前缀失效。
 * 2. SessionTokenCalibration 夹具验证非法或缺失 usage 不污染基线，存储失败/取消有终态且不重试。
 * 3. 临时 SQLite 验证会话隔离、重启、追加保留、替换/压缩清除及失败事务回滚；v9 数据库先备份再迁移。
 * 4. 固定 IPC schema 拒绝越界计数、正文扩展和指定其它会话，旧握手不能忽略新增校准功能。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Tiktoken } from "js-tiktoken/lite";
import { expect, it, vi } from "vitest";
import { createBudget, measureContext } from "../src/context/token-budget.js";
import { tokenScope, tokenAnchorSchema } from "../src/context/token-anchor.js";
import { SessionTokenCalibration } from "../src/context/session-token-calibration.js";
import { Store } from "../src/sessions/store.js";
import type { ContextSnapshot } from "../src/context/types.js";
import { runtimeIpcMessageSchema } from "../src/sandbox/runtime-ipc-protocol.js";
import { temp } from "./fixtures/helpers.js";

const capabilities = {
  tokenizer: "o200k_base",
  limits: { max_context_window_tokens: 100000, max_output_tokens: 1000 },
};
const settings = {
  baseUrl: "http://127.0.0.1:9999/v1",
  model: "test",
  reasoningEffort: "high",
};
const scope = tokenScope(settings);
const instructions = "Follow project rules.";
const tools = [{ name: "read_file" }];
const history = [
  { role: "user", content: "inspect" },
  { role: "assistant", content: "const example = 1;\n".repeat(1000) },
];
const makeBudget = () => createBudget(capabilities, 100000);
function makeAnchor(actualInput = 1000) {
  return makeBudget().snapshotUsage!(
    scope,
    actualInput,
    history,
    instructions,
    tools,
  )!;
}

it("restores cloned history without tokenizing the prefix and counts only appended items", () => {
  const anchor = makeAnchor();
  const input = structuredClone(history);
  input.push(
    { role: "assistant", content: "Done" },
    { role: "user", content: "Continue" },
  );
  const budget = makeBudget();
  const localBefore = measureContext(
    budget.measurement,
    history,
    instructions,
    tools,
  );
  const localAfter = measureContext(
    budget.measurement,
    input,
    instructions,
    tools,
  );
  const encode = vi.spyOn(Tiktoken.prototype, "encode");
  try {
    expect(
      budget.restoreAnchor!(
        JSON.parse(JSON.stringify(anchor)),
        scope,
        input,
        instructions,
        tools,
      ),
    ).toBe(true);
    expect(encode).not.toHaveBeenCalled();
    expect(budget.measure(input, instructions, tools)).toBe(
      1000 + localAfter - localBefore,
    );
    expect(encode).toHaveBeenCalledTimes(2);
    budget.measure(input, instructions, tools);
    expect(encode).toHaveBeenCalledTimes(2);
    budget.observeUsage!(500, input, instructions, tools);
    expect(budget.measure(input, instructions, tools)).toBe(500);
    budget.resetMeasurement!();
    expect(budget.measure(input, instructions, tools)).toBe(localAfter);
  } finally {
    encode.mockRestore();
  }
});

it.each(["longer", "shorter"])(
  "measures %s instructions without recounting old history or subtracting service overhead",
  (change) => {
    const anchor = makeAnchor();
    const nextInstructions =
      change === "longer" ? instructions + "New guidance. ".repeat(100) : "";
    const budget = makeBudget();
    const fixed = measureContext(
      budget.measurement,
      [],
      nextInstructions,
      tools,
    );
    const encode = vi.spyOn(Tiktoken.prototype, "encode");
    try {
      const input = structuredClone(history);
      expect(
        budget.restoreAnchor!(anchor, scope, input, nextInstructions, tools),
      ).toBe(true);
      expect(budget.measure(input, nextInstructions, tools)).toBe(
        1000 + Math.max(0, fixed - anchor.fixedTokens),
      );
      expect(encode).toHaveBeenCalledTimes(1);
    } finally {
      encode.mockRestore();
    }
  },
);

it.each([
  "model",
  "endpoint",
  "reasoning",
  "tools",
  "prefix",
  "truncate",
  "invalid",
  "version",
  "tokenizer",
])("falls back to local counting for incompatible %s", (change) => {
  let anchor: unknown = makeAnchor();
  const input = structuredClone(history);
  let selectedScope = scope;
  let selectedTools = tools;
  if (change === "model") {
    selectedScope = tokenScope({ ...settings, model: "other" });
  }

  if (change === "endpoint") {
    selectedScope = tokenScope({
      ...settings,
      baseUrl: "http://127.0.0.1:9998/v1",
    });
  }

  if (change === "reasoning") {
    selectedScope = tokenScope({ ...settings, reasoningEffort: "low" });
  }

  if (change === "tools") {
    selectedTools = [{ name: "write_file" }];
  }

  if (change === "prefix") {
    input[1].content = "Rewritten";
  }

  if (change === "truncate") {
    input.pop();
  }

  if (change === "invalid") {
    anchor = { ...makeAnchor(), actualInputTokens: -1 };
  }

  if (change === "version") {
    anchor = { ...makeAnchor(), version: 2 };
  }

  if (change === "tokenizer") {
    anchor = { ...makeAnchor(), tokenizer: "unknown" };
  }

  const budget = makeBudget();
  budget.observeUsage!(0, input, instructions, selectedTools);
  expect(
    budget.restoreAnchor!(
      anchor,
      selectedScope,
      input,
      instructions,
      selectedTools,
    ),
  ).toBe(false);
  expect(budget.measure(input, instructions, selectedTools)).toBe(
    measureContext(budget.measurement, input, instructions, selectedTools),
  );
});

it("normalizes default reasoning and recomputes capacity independently of the anchor", () => {
  expect(tokenScope({ baseUrl: settings.baseUrl, model: settings.model })).toBe(
    scope,
  );
  const budget = createBudget(capabilities, 100000, 2000, 20000);
  expect(
    budget.restoreAnchor!(makeAnchor(), scope, history, instructions, tools),
  ).toBe(true);
  expect(budget.measure(history, instructions, tools)).toBe(1000);
  // 服务最大输出为 1000，故预算为 20000 - 1000 - 1024，而非请求的 2000 输出。
  expect(budget.outputTokens).toBe(1000);
  expect(budget.limit).toBe(17976);
  expect(createBudget(undefined, 100000).restoreAnchor).toBeUndefined();
});

it("keeps valid usage when a response omits or corrupts its input count and freezes before output append", async () => {
  const budget = makeBudget();
  const write = vi.fn(async () => {});
  const calibration = new SessionTokenCalibration({
    budget,
    scope,
    read: async () => undefined,
    write,
    trace: { start: () => 1, end: () => {} },
    signal: new AbortController().signal,
  });
  const input = structuredClone(history);
  const anchor = calibration.observe(1000, input, instructions, tools)!;
  input.push({ role: "assistant", content: "New output" });
  await calibration.save(anchor);
  expect(anchor.inputItems).toBe(history.length);
  const amount = budget.measure(input, instructions, tools);
  for (const invalid of [undefined, -1, NaN, Infinity, 1.2]) {
    await calibration.save(
      calibration.observe(invalid, input, instructions, tools),
    );
    expect(budget.measure(input, instructions, tools)).toBe(amount);
  }

  expect(write).toHaveBeenCalledTimes(1);
});

it.each(["read", "write", "cancel"])(
  "traces %s failure and never retries unknown persistence",
  async (failure) => {
    const controller = new AbortController();
    const end = vi.fn();
    const read = vi.fn(async () => {
      throw new Error("read failed");
    });
    const write = vi.fn(async () => {
      throw new Error("write unknown");
    });
    const calibration = new SessionTokenCalibration({
      budget: makeBudget(),
      scope,
      read,
      write,
      trace: { start: () => 1, end },
      signal: controller.signal,
    });
    if (failure === "cancel") {
      controller.abort();
    }

    const operation =
      failure === "write"
        ? calibration.save(makeAnchor())
        : calibration.restore(history, instructions, tools);
    await expect(operation).rejects.toThrow();
    expect(end).toHaveBeenCalledWith(
      1,
      failure === "cancel" ? "cancelled" : "error",
    );
    expect(read).toHaveBeenCalledTimes(failure === "read" ? 1 : 0);
    expect(write).toHaveBeenCalledTimes(failure === "write" ? 1 : 0);
  },
);

it("persists per-session anchors across shards and restart and clears them atomically with context replacement", async () => {
  const directory = await temp();
  const database = path.join(directory, "db.sqlite");
  let store = new Store(database, { maxShardBytes: 1 });
  const first = store.create(directory, "first");
  const second = store.create(directory, "second");
  const anchor = makeAnchor();
  try {
    store.saveContext(first.id, history);
    await store.saveTokenAnchorAsync(first.id, anchor);
    await store.saveTokenAnchorAsync(second.id, {
      ...anchor,
      actualInputTokens: 2000,
    });
    await store.appendContextAsync(first.id, [
      { role: "assistant", content: "Done" },
    ]);
    expect(await store.tokenAnchorAsync(first.id)).toEqual(anchor);
    await store.closeAsync();
    store = new Store(database);
    expect(await store.tokenAnchorAsync(first.id)).toEqual(anchor);
    expect((await store.tokenAnchorAsync(second.id))?.actualInputTokens).toBe(
      2000,
    );

    const snapshot: ContextSnapshot = {
      version: 1,
      id: "snapshot",
      sessionId: first.id,
      parentId: null,
      sourceHash: "a".repeat(64),
      model: "test",
      createdAt: new Date().toISOString(),
      beforeChars: 100,
      afterChars: 50,
      cut: 1,
      source: history,
      summaries: [],
      ledger: [],
    };
    await store.compactContextAsync(first.id, snapshot, [
      { role: "user", content: "Compacted" },
    ]);
    expect(await store.tokenAnchorAsync(first.id)).toBeUndefined();
    await store.saveTokenAnchorAsync(first.id, anchor);
    await expect(
      store.compactContextAsync(first.id, snapshot, []),
    ).rejects.toThrow();
    expect(await store.tokenAnchorAsync(first.id)).toEqual(anchor);
    expect(store.context(first.id)).toEqual([
      { role: "user", content: "Compacted" },
    ]);
    // 在清除锚点之后让新上下文 INSERT 失败，验证同一事务真正恢复旧锚点和历史。
    store.db.exec(
      "CREATE TRIGGER fail_context_insert BEFORE INSERT ON context_chunks BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    await expect(
      store.compactContextAsync(first.id, { ...snapshot, id: "rollback" }, []),
    ).rejects.toThrow();
    expect(await store.tokenAnchorAsync(first.id)).toEqual(anchor);
    expect(store.contextSnapshot(first.id, "rollback")).toBeUndefined();
    store.db.exec("DROP TRIGGER fail_context_insert");
    await store.saveContextAsync(first.id, history);
    expect(await store.tokenAnchorAsync(first.id)).toBeUndefined();
    await store.saveTokenAnchorAsync(first.id, anchor);
    store.saveContext(first.id, history);
    expect(await store.tokenAnchorAsync(first.id)).toBeUndefined();
    expect((await store.tokenAnchorAsync(second.id))?.actualInputTokens).toBe(
      2000,
    );
  } finally {
    await store.closeAsync();
  }
});

it("backs up and upgrades v9 history without inventing an anchor from usage events", async () => {
  const directory = await temp();
  const database = path.join(directory, "db.sqlite");
  let store = new Store(database);
  const session = store.create(directory, "legacy");
  store.saveContext(session.id, history);
  await store.closeAsync();
  const legacy = new DatabaseSync(database);
  legacy.exec("DROP TABLE context_token_anchors; PRAGMA user_version = 9");
  legacy.close();
  store = new Store(database);
  try {
    expect(store.context(session.id)).toEqual(history);
    expect(await store.tokenAnchorAsync(session.id)).toBeUndefined();
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 10,
    });
    expect(await readdir(path.join(directory, "backups"))).toHaveLength(1);
    store.db
      .prepare("INSERT INTO context_token_anchors VALUES(?,?)")
      .run(session.id, JSON.stringify({ ...makeAnchor(), version: 0 }));
    expect(await store.tokenAnchorAsync(session.id)).toBeUndefined();
  } finally {
    await store.closeAsync();
  }
});

it("bounds IPC anchors and rejects caller-selected sessions, raw text and old protocol versions", () => {
  const anchor = makeAnchor();
  const request = {
    type: "request",
    requestId: "save",
    operation: "session_save_token_anchor",
    body: { anchor },
  };
  expect(runtimeIpcMessageSchema.safeParse(request).success).toBe(true);
  expect(
    runtimeIpcMessageSchema.safeParse({
      ...request,
      body: { anchor, sessionId: "other" },
    }).success,
  ).toBe(false);
  for (const invalid of [
    { ...anchor, inputItems: Number.MAX_SAFE_INTEGER + 1 },
    { ...anchor, rawTokens: 0 },
    { ...anchor, instructions: "private text" },
  ]) {
    expect(tokenAnchorSchema.safeParse(invalid).success).toBe(false);
    expect(
      runtimeIpcMessageSchema.safeParse({
        ...request,
        body: { anchor: invalid },
      }).success,
    ).toBe(false);
  }

  const hello = {
    type: "runtime_hello",
    protocolVersion: 9,
    taskId: "task",
    sessionId: "session",
    executionInstanceId: "instance",
    nonce: "n".repeat(32),
  };
  expect(runtimeIpcMessageSchema.safeParse(hello).success).toBe(false);
  expect(
    runtimeIpcMessageSchema.safeParse({ ...hello, protocolVersion: 11 })
      .success,
  ).toBe(true);
});
