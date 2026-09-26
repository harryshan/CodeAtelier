/**
 * 验证全文版本变化的读取兼容性，以及默认只摘要时不进行额外文件探测。
 *
 * 1. 读取局部行也记录全文字节哈希；外部修改不在返回范围内的行仍能识别版本变化。
 * 2. 通过 ContextManager 验证阈值前和摘要阶段均不探测，原始记录与重启回读完整。
 * 3. 直接检查投影的保守边界：缺失哈希、失败、截断、重复 ID 和无法核实均不判过期。
 * 4. 检查敏感/越界/缺失/过大文件探测、取消以及探测不授予编辑凭证。
 *
 * 模型为本地桩；测试不调用真实模型，不运行 Evaluation，也不写用户项目。
 */

import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileFixture, temp } from "./fixtures/helpers.js";
import { ContextManager } from "../src/context/context-manager.js";
import {
  currentReadHashes,
  projectReads,
} from "../src/context/read-projection.js";
import { readContextHistory } from "../src/context/history.js";
import { Store } from "../src/sessions/store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function records(result: any, id = "read") {
  return [
    {
      type: "function_call",
      name: "read_file",
      call_id: id,
      arguments: JSON.stringify({
        path: result.path,
        startLine: 1,
        endLine: 1,
      }),
    },
    {
      type: "function_call_output",
      call_id: id,
      output: JSON.stringify(result),
    },
  ];
}

function event(result: any, id = "read"): any {
  return {
    type: "tool_result",
    data: { callId: id, name: "read_file", result },
  };
}

it("summarizes externally changed reads without probing files or projecting history", async () => {
  const f = await fileFixture();
  const file = path.join(f.root, "a.ts");
  const original = "x".repeat(16000) + "\nunchanged";
  await writeFile(file, original);
  const read = await f.runner.execute("read_file", {
    path: "a.ts",
    startLine: 1,
    endLine: 1,
  });
  expect(read.contentHash).toBe(hash(original));
  expect(read.text).not.toContain("unchanged");
  await writeFile(file, "x".repeat(16000) + "\nexternal change");

  const db = path.join(await temp(), "history.db");
  const store = new Store(db);
  const session = store.create(f.root, "versions");
  const probe = vi.fn((name: string) => f.runner.currentFileHash(name));
  const excerpts: string[] = [];
  const model = vi.fn(async (input: any[]) => {
    excerpts.push(
      ...JSON.parse(input[0].content).map((record: any) => record.excerpt),
    );

    return {
      output: [],
      text: JSON.stringify({
        completed: [],
        conclusions: [],
        verification: [],
        pending: [],
      }),
    };
  });
  const options = {
    store,
    sessionId: session.id,
    model: "test",
    limit: 12000,
    provider: { run: model },
    signal: f.controller.signal,
    currentFileHash: probe,
    clean: (text: string) => text,
    notice: () => {},
    report: () => {},
  };
  const source = [
    { role: "user", content: "inspect" },
    ...records(read),
    { role: "user", content: "continue" },
  ];
  let reopened: Store | undefined;
  let closed = false;
  try {
    store.event(session.id, "task", "tool_result", {
      callId: "read",
      name: "read_file",
      result: read,
    });
    store.saveContext(session.id, source);
    const roomy = new ContextManager({ ...options, limit: 100000 });
    expect(await roomy.prepare(source, "", [])).toBe(source);
    expect(probe).not.toHaveBeenCalled();

    const next = await new ContextManager(options).prepare(source, "", []);
    const snapshot = store.latestContextSnapshot(session.id)!;
    expect(snapshot.stage).toBe("summary");
    expect(model).toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(excerpts.join("")).toContain(JSON.stringify(source[2]));
    expect(snapshot.projections).toBeUndefined();
    expect(next).not.toContainEqual(source[2]);
    expect(snapshot.ledger[0]).toMatchObject({
      status: "recorded",
      result: JSON.stringify({ truncated: false }),
    });
    expect(snapshot.source[2]).toEqual(source[2]);
    expect(store.events(session.id)[0].data.result).toEqual(read);
    store.close();
    closed = true;
    reopened = new Store(db);
    expect(reopened.context(session.id)).toEqual(next);
    const page = readContextHistory(
      reopened,
      session.id,
      { snapshotId: snapshot.id, index: 2, offset: 0 },
      150000,
    );
    expect(JSON.parse(page.text)).toEqual(source[2]);
  } finally {
    reopened?.close();
    if (!closed) {
      store.close();
    }
  }
});

it("preserves unverifiable, unchanged, legacy, failed, truncated and ambiguous reads", async () => {
  const base = {
    path: "a.ts",
    contentHash: hash("old"),
    text: "x".repeat(3000),
  };
  for (const extra of [
    { contentHash: undefined },
    { error: "failure" },
    { truncated: true },
    { contextEncoding: "existing" },
  ]) {
    const result = { ...base, ...extra };
    const source = records(result);
    expect(
      projectReads(
        source,
        "snapshot",
        [event(result)],
        "deduplicate",
        new Map([["a.ts", hash("new")]]),
      ),
    ).toEqual(source);
  }

  const source = records(base);
  for (const current of [undefined, base.contentHash]) {
    expect(
      projectReads(
        source,
        "snapshot",
        [event(base)],
        "deduplicate",
        new Map([["a.ts", current]]),
      ),
    ).toEqual(source);
  }

  const ambiguous = [...source, source[1]];
  expect(
    projectReads(
      ambiguous,
      "snapshot",
      [event(base)],
      "deduplicate",
      new Map([["a.ts", hash("new")]]),
    ),
  ).toEqual(ambiguous);
  const probe = vi.fn(async () => undefined);
  const both = [...source, ...records(base, "other")];
  const hashes = await currentReadHashes(
    both,
    [event(base), event(base, "other")],
    probe,
    new AbortController().signal,
  );
  expect(probe).toHaveBeenCalledTimes(1);
  expect(hashes.get("a.ts")).toBeUndefined();
});

it("probes safe files without granting fresh read permission and propagates cancellation", async () => {
  const f = await fileFixture();
  const file = path.join(f.root, "a.ts");
  await writeFile(file, "old");
  await f.runner.execute("read_file", {
    path: "a.ts",
    startLine: 1,
    endLine: 1,
  });
  await writeFile(file, "new");
  expect(await f.runner.currentFileHash(file)).toBe(hash("new"));
  const result = await f.runner.execute("edit_files", {
    files: [
      {
        path: "a.ts",
        create: false,
        edits: [
          { oldText: "new", newText: "edited", startLine: null, endLine: null },
        ],
      },
    ],
  });
  expect(result.error).toBeDefined();

  const outside = path.join(await temp(), "outside.ts");
  await writeFile(outside, "outside");
  await writeFile(path.join(f.root, ".env"), "private");
  await writeFile(
    path.join(f.root, "large"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  await mkdir(path.join(f.root, "directory"));
  for (const name of [outside, ".env", "missing", "large", "directory"]) {
    expect(await f.runner.currentFileHash(name)).toBeUndefined();
  }

  f.controller.abort();
  await expect(f.runner.currentFileHash(file)).rejects.toThrow();
});

it("archives only stale versions of the same path and skips replacements that grow the input", () => {
  const old = {
    path: "a.ts",
    contentHash: hash("old"),
    text: "old".repeat(1000),
  };
  const latest = { ...old, contentHash: hash("new"), text: "new".repeat(1000) };
  const source = [...records(old), ...records(latest, "latest")];
  const next = projectReads(
    source,
    "snapshot",
    [event(old), event(latest, "latest")],
    "deduplicate",
    new Map([["a.ts", latest.contentHash]]),
  );
  expect(JSON.parse(next[1].output).contextArchive.reason).toBe(
    "stale-file-version",
  );
  expect(next[3]).toEqual(source[3]);
  expect(source[1].output).toBe(JSON.stringify(old));

  const tiny = { ...old, text: "x" };
  expect(
    projectReads(
      records(tiny),
      "snapshot",
      [event(tiny)],
      "deduplicate",
      new Map([["a.ts", latest.contentHash]]),
    ),
  ).toEqual(records(tiny));
});
