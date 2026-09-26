/*
 * 在临时工作区验证 subagent 白名单只读代理的行为，不使用模型、Git、shell 或用户项目。
 *
 * 1. 分配目录范围后按行读取并校验全文哈希、枚举条目及限制搜索结果。
 * 2. 尝试写入工具、敏感文件及越界路径；验证执行失败且文件保持不变。
 * 3. 验证长行、大文件搜索、宽/深目录与调用方选择的结果数量不受子任务专属上限截断。
 * 4. 保留共有的文件读取大小和分页限制，并验证取消阻止后续读取。
 *
 * 这是工具层回归，不是恶意 Worker 的 OS 级隔离测试。
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SubagentReadOnly } from "../src/tools/subagent-readonly.js";
import { temp } from "./fixtures/helpers.js";

it("reads with versions and searches only inside the assigned directory", async () => {
  const root = await temp();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "code.ts"), "alpha\nbeta\nalpha\n");
  await writeFile(path.join(root, ".env"), "private");
  const reader = await SubagentReadOnly.create(
    root,
    ["src"],
    new AbortController().signal,
  );

  expect(
    await reader.execute("read_file", {
      path: "src/code.ts",
      startLine: 2,
      endLine: 2,
    }),
  ).toMatchObject({
    text: "2: beta",
    contentHash: createHash("sha256")
      .update("alpha\nbeta\nalpha\n")
      .digest("hex"),
  });
  expect(
    await reader.execute("list_entries", { path: "src", maxEntries: 10 }),
  ).toMatchObject({ entries: [{ name: "code.ts" }] });
  expect(
    await reader.execute("search_text", {
      path: "src",
      pattern: "alpha",
      maxMatches: 1,
    }),
  ).toMatchObject({ matches: [{ line: 1 }], truncated: true });
  await expect(
    reader.execute("edit_files", { path: "src/code.ts" }),
  ).rejects.toThrow("只读工具");
  await expect(
    reader.execute("read_file", { path: ".env", startLine: 1, endLine: 1 }),
  ).rejects.toThrow("许可范围");
  await expect(
    reader.execute("read_file", {
      path: "../outside",
      startLine: 1,
      endLine: 1,
    }),
  ).rejects.toThrow("许可范围");
  expect(await readFile(path.join(root, "src", "code.ts"), "utf8")).toBe(
    "alpha\nbeta\nalpha\n",
  );
});

it("returns long lines intact and uses the shared read pagination limit", async () => {
  const root = await temp();
  const longLine = "x".repeat(40_000);
  await writeFile(
    path.join(root, "long.txt"),
    `${longLine}\n${"tail\n".repeat(600)}`,
  );
  const reader = await SubagentReadOnly.create(
    root,
    ["."],
    new AbortController().signal,
  );

  const result = await reader.execute("read_file", {
    path: "long.txt",
    startLine: 1,
    endLine: 601,
  });
  expect(result).toMatchObject({
    text: [
      `1: ${longLine}`,
      ...Array.from({ length: 499 }, (_, index) => `${index + 2}: tail`),
    ].join("\n"),
    returnedEndLine: 500,
    truncated: true,
    hasMore: true,
    nextStartLine: 501,
  });

  await writeFile(
    path.join(root, "large.txt"),
    "x".repeat(2 * 1024 * 1024 + 1),
  );
  await expect(
    reader.execute("read_file", {
      path: "large.txt",
      startLine: 1,
      endLine: 1,
    }),
  ).rejects.toThrow("文件过大");
});

it("searches large files without byte or line-text caps and honors the requested match count", async () => {
  const root = await temp();
  const pattern = "needle".repeat(25);
  const matchingLine = `${pattern}${"x".repeat(300)}`;
  await writeFile(
    path.join(root, "large.txt"),
    `${"padding\n".repeat(750_000)}${`${matchingLine}\n`.repeat(150)}`,
  );
  const reader = await SubagentReadOnly.create(
    root,
    ["."],
    new AbortController().signal,
  );

  const result = await reader.execute("search_text", {
    path: ".",
    pattern,
    maxMatches: 120,
  });
  expect(result).toMatchObject({
    matches: Array.from({ length: 120 }, (_, index) => ({
      path: "large.txt",
      line: 750_001 + index,
      text: matchingLine,
    })),
    truncated: true,
  });
});

it("lists and searches beyond the former entry, file and depth limits", async () => {
  const root = await temp();
  for (let index = 0; index < 305; index++) {
    await writeFile(
      path.join(root, `${String(index).padStart(3, "0")}.txt`),
      "needle",
    );
  }

  const deep = path.join(...Array.from({ length: 8 }, () => "nested"));
  await mkdir(path.join(root, deep), { recursive: true });
  await writeFile(path.join(root, deep, "last.txt"), "needle");
  const reader = await SubagentReadOnly.create(
    root,
    ["."],
    new AbortController().signal,
  );

  const listing = await reader.execute("list_entries", {
    path: ".",
    maxEntries: 400,
  });
  expect(listing).toHaveProperty("entries.length", 306);
  const result = await reader.execute("search_text", {
    path: ".",
    pattern: "needle",
    maxMatches: 400,
  });
  expect(result).toHaveProperty("matches.length", 306);
  expect(result).toMatchObject({
    matches: expect.arrayContaining([
      { path: path.join(deep, "last.txt"), line: 1, text: "needle" },
    ]),
    examined: 306,
    truncated: false,
  });
});

it("stops searches after task cancellation", async () => {
  const root = await temp();
  const controller = new AbortController();
  const reader = await SubagentReadOnly.create(root, ["."], controller.signal);
  controller.abort(new Error("cancelled"));

  await expect(
    reader.execute("search_text", {
      path: ".",
      pattern: "needle",
      maxMatches: 1,
    }),
  ).rejects.toThrow("cancelled");
});
