/**
 * 通过真实 ToolRunner 和临时文件验证 read_file 的 Worker 路径。
 * 用例不模拟 Worker：它们创建包含 Unicode、CRLF、尾随换行和空字节的文件，检查 Worker 返回的全文哈希、总行数、分页和可见空白
 * 与既有工具契约一致，并同时发起四个大文件读取以覆盖共享池的独立并发调用。所有文件在临时目录清理，不访问真实模型或工作区。
 *
 * 1. createRunner 组装最小 ToolContext，保持路径/读取哈希和实际 Worker 生命周期。
 * 2. 第一组断言行范围和内容哈希，第二组断言二进制拒绝，最后一组断言多个独立读取均可完成。
 */

import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ToolRunner } from "../src/tools/tool-runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRunner() {
  const root = await mkdtemp(path.join(tmpdir(), "codeatelier-read-worker-"));
  roots.push(root);

  return {
    root,
    runner: new ToolRunner({
      root,
      sessionId: "session",
      taskId: "task",
      signal: new AbortController().signal,
      settings: {} as never,
      approvals: { request: async () => true },
      emit: () => {},
    }),
  };
}

it("preserves full hashes and line pagination without allocating all file lines", async () => {
  const { root, runner } = await createRunner();
  const content = "第一行\r\nsecond line\nthird line\n";
  const source = path.join(root, "source.txt");
  await writeFile(source, content);

  const result = await runner.execute("read_file", {
    path: "source.txt",
    startLine: 1,
    endLine: 2,
    whitespaceMode: true,
  });

  expect(result).toEqual({
    path: await realpath(source),
    contentHash: createHash("sha256").update(content).digest("hex"),
    totalLines: 4,
    returnedEndLine: 2,
    truncated: false,
    hasMore: true,
    nextStartLine: 3,
    text: "1: 第一行\r\n2: second line",
    visibleText: "1: 第一行␍↵\n2: second·line↵",
  });

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await expect(
    runner.execute("read_file", {
      path: "source.txt",
      startLine: 3,
      endLine: 3,
    }),
  ).resolves.toMatchObject({ text: "3: third line" });
});

it("rejects binary bytes in the Worker before returning a read credential", async () => {
  const { root, runner } = await createRunner();
  await writeFile(
    path.join(root, "binary.bin"),
    Buffer.from([0x61, 0x00, 0x62]),
  );

  await expect(
    runner.execute("read_file", {
      path: "binary.bin",
      startLine: 1,
      endLine: 1,
    }),
  ).rejects.toThrow("不支持二进制文件");
});

it("finishes four independent large reads through the shared bounded pool", async () => {
  const { root, runner } = await createRunner();
  const content = "line\n".repeat(300_000);
  const files = ["a.txt", "b.txt", "c.txt", "d.txt"];
  await Promise.all(
    files.map((file) => writeFile(path.join(root, file), content)),
  );

  const results = await Promise.all(
    files.map((file, index) =>
      runner.forCall(`call-${index}`).execute("read_file", {
        path: file,
        startLine: 1,
        endLine: 10,
      }),
    ),
  );

  expect(results.map((result) => result.totalLines)).toEqual([
    300_001, 300_001, 300_001, 300_001,
  ]);
  expect(
    results.every((result) => result.contentHash === results[0].contentHash),
  ).toBe(true);
});
