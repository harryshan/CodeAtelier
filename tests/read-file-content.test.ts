/**
 * 验证 read_file 异步读完后直接计算的结果与失败边界，不依赖模型或个人文件。
 * 1. 纯计算用例检查空文件、CRLF、UTF-8、末尾空行、分页与 Buffer 子视图的全文哈希。
 * 2. 真实 ToolRunner 用例检查阶段顺序、二进制失败和读后取消不产生编辑凭证。
 * 3. 并发读取通过 forCall 共享凭证并独立返回结果，不需要读取线程池或任务级关闭。
 * 临时文件和取消由公共测试夹具管理；同步计算不声称支持中途抢占。
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  processReadFile,
  type ReadFileTrace,
} from "../src/tools/read-file-content.js";
import { fileFixture } from "./fixtures/helpers.js";

it.each([
  { content: "", text: "1: ", visibleText: "1: ↵", totalLines: 1 },
  {
    content: "第一行\r\nsecond\t line\n",
    text: "1: 第一行\r\n2: second\t line\n3: ",
    visibleText: "1: 第一行␍↵\n2: second→·line↵\n3: ↵",
    totalLines: 3,
  },
])(
  "preserves byte hashes and whitespace for $totalLines lines",
  ({ content, text, visibleText, totalLines }) => {
    const backing = Buffer.from(`prefix${content}suffix`);
    const bytes = backing.subarray(6, backing.length - 6);
    expect(
      processReadFile(bytes, {
        startLine: 1,
        endLine: 500,
        maxLines: 500,
        whitespaceMode: true,
      }),
    ).toEqual({
      contentHash: createHash("sha256").update(content).digest("hex"),
      totalLines,
      returnedEndLine: totalLines,
      truncated: false,
      hasMore: false,
      nextStartLine: null,
      text,
      visibleText,
    });
  },
);

it("caps requested lines without truncating long line contents", () => {
  const bytes = Buffer.from("x".repeat(40000) + "\nline".repeat(600));
  const result = processReadFile(bytes, {
    startLine: 1,
    endLine: 601,
    maxLines: 500,
    whitespaceMode: false,
  });
  expect(result).toMatchObject({
    totalLines: 601,
    returnedEndLine: 500,
    truncated: true,
    hasMore: true,
    nextStartLine: 501,
  });
  expect(result.text.split("\n")).toHaveLength(500);
  expect(result.text.startsWith("1: " + "x".repeat(40000))).toBe(true);
  expect(
    processReadFile(bytes, {
      startLine: 602,
      endLine: 610,
      maxLines: 500,
      whitespaceMode: false,
    }),
  ).toMatchObject({ text: "", hasMore: false, nextStartLine: null });
});

it("computes after reading and shares the successful credential with dependent edits", async () => {
  const { root, runner } = await fileFixture();
  const content = "第一行\r\nsecond line\nthird line\n";
  await writeFile(path.join(root, "source.txt"), content);
  const stages: Array<{ stage: string; state: string; details?: unknown }> = [];
  const trace: ReadFileTrace = (stage, state, details) =>
    stages.push({ stage, state, details });
  const result = await runner
    .forCall("read")
    .execute(
      "read_file",
      { path: "source.txt", startLine: 1, endLine: 2, whitespaceMode: true },
      undefined,
      trace,
    );

  expect(result).toMatchObject({
    contentHash: createHash("sha256").update(content).digest("hex"),
    totalLines: 4,
    returnedEndLine: 2,
    hasMore: true,
    nextStartLine: 3,
    text: "1: 第一行\r\n2: second line",
    visibleText: "1: 第一行␍↵\n2: second·line↵",
  });
  expect(stages.map(({ stage, state }) => [stage, state])).toEqual([
    ["read_file.stat", "started"],
    ["read_file.stat", "ok"],
    ["read_file.bytes", "started"],
    ["read_file.bytes", "ok"],
    ["read_file.compute", "started"],
    ["read_file.compute", "ok"],
  ]);
  expect(stages[3].details).toEqual({ bytes: Buffer.byteLength(content) });
  expect(stages[5].details).toEqual({ computeMs: expect.any(Number) });
  const edited = await runner.forCall("edit").execute("edit_files", {
    files: [
      {
        path: "source.txt",
        create: false,
        fileVersion: result.contentHash,
        edits: [{ oldText: "second line", newText: "updated" }],
      },
    ],
  });
  expect(edited.files).toEqual([
    expect.objectContaining({ path: "source.txt", status: "written" }),
  ]);
  expect(await readFile(path.join(root, "source.txt"), "utf8")).toBe(
    content.replace("second line", "updated"),
  );
});

it("rejects binary data even outside the requested range and closes the compute trace", async () => {
  const { root, runner } = await fileFixture();
  await writeFile(
    path.join(root, "binary.bin"),
    Buffer.from("first\nsecond\0"),
  );
  const stages: Array<{ stage: string; state: string }> = [];
  await expect(
    runner.execute(
      "read_file",
      { path: "binary.bin", startLine: 1, endLine: 1 },
      undefined,
      (stage, state) => stages.push({ stage, state }),
    ),
  ).rejects.toThrow("不支持二进制文件");
  expect(stages.at(-1)).toEqual({ stage: "read_file.compute", state: "error" });
  await writeFile(path.join(root, "binary.bin"), "read failed");
  const edited = await runner.execute("edit_files", {
    files: [
      {
        path: "binary.bin",
        create: false,
        fileVersion: null,
        edits: [{ oldText: "read failed", newText: "must not write" }],
      },
    ],
  });
  expect(edited.files).toEqual([
    expect.objectContaining({ path: "binary.bin", status: "failed" }),
  ]);
  expect(await readFile(path.join(root, "binary.bin"), "utf8")).toBe(
    "read failed",
  );
});

it("honors cancellation after bytes arrive and before synchronous computation", async () => {
  const { root, runner, controller } = await fileFixture();
  await writeFile(path.join(root, "source.txt"), "line\n");
  const stages: Array<{ stage: string; state: string }> = [];
  await expect(
    runner.execute(
      "read_file",
      { path: "source.txt", startLine: 1, endLine: 1 },
      undefined,
      (stage, state) => {
        stages.push({ stage, state });
        if (stage === "read_file.bytes" && state === "ok") {
          controller.abort(new Error("cancelled after read"));
        }
      },
    ),
  ).rejects.toThrow("cancelled after read");
  expect(stages.at(-1)).toEqual({
    stage: "read_file.compute",
    state: "cancelled",
  });
});

it("returns independent results for four concurrent large reads", async () => {
  const { root, runner } = await fileFixture();
  const files = ["a.txt", "b.txt", "c.txt", "d.txt"];
  const content = "line\n".repeat(300000);
  await Promise.all(
    files.map((file) => writeFile(path.join(root, file), content)),
  );
  const results = await Promise.all(
    files.map((file, index) =>
      runner
        .forCall(`call-${index}`)
        .execute("read_file", { path: file, startLine: 1, endLine: 10 }),
    ),
  );
  for (const result of results) {
    expect(result).toMatchObject({
      totalLines: 300001,
      returnedEndLine: 10,
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
  }
});
