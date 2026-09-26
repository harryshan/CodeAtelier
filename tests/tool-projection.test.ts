/**
 * 检查第二级工具正文归档及跨次压缩的恢复事实，所有事件和模型来自本地夹具。
 *
 * 1. pair/saved 生成完整工具协议对及匹配事件；验证旧搜索记录、目录省略数量、命令诊断。
 * 2. 验证只读 Git 输出和写文件 diff 缩短，Git 提交/推送输出及批次未知状态原样保留。
 * 3. 验证缺失/歧义来源、未知格式、无退出码、已有归档和短结果不被替换。
 * 4. 真实 Store 和 ContextManager 验证默认直接摘要、原子快照、重启回读及执行账本。
 *
 * 不运行真实命令或模型，不执行 Evaluation。输出中的失败不能因归档变成成功。
 */

import { expect, it, vi } from "vitest";
import path from "node:path";
import { projectToolResults } from "../src/context/tool-projection.js";
import { executionLedger } from "../src/context/snapshot.js";
import { ContextManager } from "../src/context/context-manager.js";
import { Store } from "../src/sessions/store.js";
import { readContextHistory } from "../src/context/history.js";
import { temp } from "./fixtures/helpers.js";

function pair(name: string, result: any, args: any = {}, id = name) {
  return [
    {
      type: "function_call",
      call_id: id,
      name,
      arguments: JSON.stringify(args),
    },
    {
      type: "function_call_output",
      call_id: id,
      output: JSON.stringify(result),
    },
  ];
}

function saved(name: string, result: any, id = name): any {
  return { type: "tool_result", data: { name, callId: id, result } };
}

function project(name: string, result: any, args: any = {}) {
  const source = pair(name, result, args);
  const next = projectToolResults(source, "snapshot", [saved(name, result)]);
  expect(next[0]).toBe(source[0]);
  expect(source[1].output).toBe(JSON.stringify(result));

  return JSON.parse(next[1].output!);
}

const longOutput = [
  "start",
  "a".repeat(8000),
  "ERROR middle failure",
  "b".repeat(8000),
  "end",
].join(String.fromCharCode(10));

it("archives legacy search text while retaining every location, query and truncation flag", () => {
  const matches = Array.from({ length: 30 }, (_, line) => ({
    path: "src/file" + line + ".ts",
    line,
    kind: "content",
    text: "code".repeat(100),
  }));
  const result = project(
    "search",
    { matches, truncated: true },
    { path: "src", query: "code" },
  );
  expect(result.matches).toEqual(
    matches.map((match) =>
      Object.fromEntries(
        Object.entries(match).filter(([key]) => key !== "text"),
      ),
    ),
  );
  expect(result.truncated).toBe(true);
  expect(result.contextArchive.fields).toEqual(["matches[].text"]);
});

it("marks a shortened directory listing as incomplete without inventing disk totals", () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    name: "long-file-" + index + ".ts",
    type: "file",
  }));
  const result = project("list_files", entries, { path: "src" });
  expect(result.entries).toEqual([
    ...entries.slice(0, 20),
    ...entries.slice(-20),
  ]);
  expect(result.originalEntryCount).toBe(100);
  expect(result.omittedEntryCount).toBe(60);
  expect(result.contextArchive.omitted).toBe(true);
});

it("preserves failed command metadata and middle diagnostic lines with a history reference", () => {
  const metadata = {
    exitCode: 1,
    truncated: true,
    timedOut: false,
    cancelled: false,
    error: "tests failed",
    custom: { diagnosticId: "case-1" },
  };
  const result = project(
    "run_command",
    { ...metadata, output: longOutput },
    { command: "test" },
  );
  const { output, contextArchive, ...retained } = result;
  expect(retained).toEqual(metadata);
  expect(output).toContain("ERROR middle failure");
  expect(output).toContain("非连续原文");
  expect(output.length).toBeLessThan(longOutput.length);
  expect(contextArchive).toMatchObject({
    snapshotId: "snapshot",
    index: 1,
    fields: ["output"],
  });
});

it("archives read-only Git output but retains commit, push and staging results verbatim", () => {
  for (const action of ["status", "diff", "log", "show", "branch"]) {
    const result = project(
      "git",
      { output: longOutput, exitCode: 0, truncated: false },
      { request: { action, revision: "HEAD", paths: ["a.ts"] } },
    );
    expect(result.contextArchive.fields).toEqual(["output"]);
    expect(result.exitCode).toBe(0);
  }

  for (const action of ["add", "commit", "push"]) {
    const result = {
      output: longOutput,
      exitCode: 0,
      commit: {
        output: "commit-identifier",
        exitCode: 0,
        truncated: false,
      },
    };
    const source = pair("git", result, { request: { action } });
    expect(
      projectToolResults(source, "snapshot", [saved("git", result)]),
    ).toEqual(source);
  }
});

it("shrinks only diffs while retaining each partial write status and error", () => {
  const result = {
    batchId: "batch",
    error: "second file failed",
    files: [
      { path: "a.ts", status: "written", changed: true, diff: longOutput },
      { path: "b.ts", status: "unknown", error: "rename failed" },
      { path: "c.ts", status: "not_attempted" },
    ],
  };
  const next = project("edit_files", result);
  expect(next.files[0]).toMatchObject({
    path: "a.ts",
    status: "written",
    changed: true,
  });
  expect(next.files[0].diff.length).toBeLessThan(longOutput.length);
  expect(next.files.slice(1)).toEqual(result.files.slice(1));
  expect(next.error).toBe(result.error);
  expect(next.batchId).toBe(result.batchId);
  expect(next.contextArchive.fields).toEqual(["files[0].diff"]);
  const write = project("write_file", {
    path: "a.ts",
    changed: true,
    diff: longOutput,
  });
  expect(write.path).toBe("a.ts");
  expect(write.changed).toBe(true);
  expect(write.contextArchive.fields).toEqual(["diff"]);
});

it("leaves unknown and ambiguous sources, absent exit status, archived and short results intact", () => {
  const result = { output: longOutput, exitCode: 1 };
  const source = pair("run_command", result);
  for (const events of [
    [],
    [saved("other", result)],
    [saved("run_command", result), saved("run_command", result)],
  ]) {
    expect(projectToolResults(source, "snapshot", events)).toEqual(source);
  }

  const repeated = [...source, source[1]];
  expect(
    projectToolResults(repeated, "snapshot", [saved("run_command", result)]),
  ).toEqual(repeated);
  for (const value of [
    { output: longOutput },
    { output: longOutput, exitCode: null },
    { ...result, contextArchive: {} },
    { output: "short", exitCode: 0 },
  ]) {
    const items = pair("run_command", value);
    expect(
      projectToolResults(items, "snapshot", [saved("run_command", value)]),
    ).toEqual(items);
  }
});

it("summarizes tool results directly, persists originals and retains execution state", async () => {
  const db = path.join(await temp(), "tools.db");
  let store = new Store(db);
  const session = store.create(await temp(), "tools");
  const requests: any[][] = [];
  const run = vi.fn(async (input: any[]) => {
    requests.push(JSON.parse(input[0].content));

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
    signal: new AbortController().signal,
    provider: { run },
    clean: (text: string) => text,
    notice: () => {},
    report: () => {},
  };
  const command = { output: longOutput, exitCode: 1, truncated: true };
  const batch = {
    batchId: "batch",
    error: "partial",
    files: [
      { path: "a.ts", status: "written", diff: longOutput },
      { path: "b.ts", status: "unknown" },
      { path: "c.ts", status: "not_attempted" },
    ],
  };
  const source = [
    { role: "user", content: "keep failures" },
    ...pair("run_command", command, { command: "test" }),
    ...pair("edit_files", batch),
    { role: "user", content: "continue" },
  ];
  try {
    for (const [name, result] of [
      ["run_command", command],
      ["edit_files", batch],
    ] as const) {
      store.event(session.id, "task", "tool_result", {
        name,
        callId: name,
        result,
      });
    }

    store.saveContext(session.id, source);
    expect(
      await new ContextManager({ ...options, limit: 100000 }).prepare(
        source,
        "",
        [],
      ),
    ).toBe(source);
    expect(store.latestContextSnapshot(session.id)).toBeUndefined();

    const next = await new ContextManager(options).prepare(source, "", []);
    const snapshot = store.latestContextSnapshot(session.id)!;
    expect(snapshot.stage).toBe("summary");
    expect(run).toHaveBeenCalled();
    expect(snapshot.projections).toBeUndefined();
    expect(snapshot.source).toEqual(source);
    expect(next[0]).toEqual(source[0]);
    expect(next.at(-1)).toEqual(source.at(-1));
    for (const index of [2, 4]) {
      const excerpts = requests
        .flat()
        .filter((record) => record.index === index)
        .map((record) => record.excerpt);
      expect(excerpts.join("")).toBe(JSON.stringify(source[index]));
    }

    store.close();
    store = new Store(db);
    expect(store.context(session.id)).toEqual(next);
    let offset = 0;
    let original = "";
    while (true) {
      const page = readContextHistory(
        store,
        session.id,
        { snapshotId: snapshot.id, index: 2, offset },
        5000,
      );
      original += page.text;
      if (page.nextOffset === null) {
        break;
      }

      offset = page.nextOffset;
    }

    expect(JSON.parse(original)).toEqual(source[2]);

    await new ContextManager({ ...options, store }).prepare(
      [
        ...next,
        { role: "assistant", content: "z".repeat(18000) },
        { role: "user", content: "again" },
      ],
      "",
      [],
    );
    expect(store.latestContextSnapshot(session.id)!.stage).toBe("summary");
    expect(store.contextSnapshot(session.id, snapshot.id)).toEqual(snapshot);
    const ledger = store.latestContextSnapshot(session.id)!.ledger;
    expect(
      JSON.parse(ledger.find((entry) => entry.callId === "edit_files")!.result)
        .files,
    ).toEqual(
      batch.files.map((file) =>
        Object.fromEntries(
          Object.entries(file).filter(([key]) => key !== "diff"),
        ),
      ),
    );
    expect(store.events(session.id)[0].data.result).toEqual(command);
  } finally {
    store.close();
  }
});

it("preserves nested Git failures and long per-file state as valid ledger JSON", () => {
  const git = {
    paths: ["a.ts"],
    stage: { output: "error", exitCode: 1, truncated: false },
    commit: null,
  };
  const batch = {
    batchId: "batch",
    files: Array.from({ length: 30 }, (_, index) => ({
      path: "file-" + index + ".ts",
      status: index === 0 ? "unknown" : "not_attempted",
    })),
  };
  const source = [
    ...pair("git", git, { request: { action: "commit" } }),
    ...pair("edit_files", batch),
  ];
  const ledger = executionLedger(source, [
    saved("git", git),
    saved("edit_files", batch),
  ]);
  expect(JSON.parse(ledger[0].result)).toEqual({
    paths: ["a.ts"],
    stage: { exitCode: 1, truncated: false },
    commit: null,
  });
  expect(JSON.parse(ledger[1].result)).toEqual(batch);
  expect(ledger[1].result.length).toBeGreaterThan(500);
});
