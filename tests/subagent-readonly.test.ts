/*
 * 在临时工作区验证 subagent 白名单只读代理的行为，不使用模型、Git、shell 或用户项目。
 *
 * 1. 分配目录范围后按行读取并校验全文哈希、枚举条目及限制搜索结果。
 * 2. 尝试写入工具、敏感文件及越界路径；验证执行失败且文件保持不变。
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
