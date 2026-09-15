/**
 * 通过 fileFixture 调用真实 ToolRunner，检查文件工具的结果和磁盘上的变化。
 * 所有文件都建在临时目录，审批由用例明确处理。
 *
 * 1. 检查目录过滤、字面搜索、结果数量限制和带行号、分页元数据的分段读取。
 * 2. 检查模型可见的定位/小范围读取契约，以及反向行区间、二进制文件和过大文件被拒绝。
 * 3. 检查多处快照替换、整批失败不写入、成功后复用读取状态、创建父目录、美元符号按原文替换，以及整文件覆盖需要审批。
 * 4. 在等待审批时修改文件，并检查规则文件、敏感文件和非法工具参数的处理。
 *
 * 拒绝或校验失败后，原文件必须保持不变，不能只检查是否弹出了审批。
 */

import { it, expect } from "vitest";
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { definitions } from "../src/tools/registry.js";
import type { ToolRunner } from "../src/tools/tool-runner.js";
import { fileFixture } from "./fixtures/helpers.js";

/** 将单文件场景包装为唯一 edit_files 工具所需的 files 数组。 */
async function editSingleFile(runner: ToolRunner, path: string, edits: any[]) {
  const result = await runner.execute("edit_files", {
    files: [{ path, edits }],
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return result;
}

it("lists usable immediate entries without dependency, build or sensitive files", async () => {
  const { root, runner } = await fileFixture();

  for (const name of ["src", "node_modules", "dist", ".git"]) {
    await mkdir(path.join(root, name));
  }

  for (const name of ["README.md", ".env", "secret.pem"]) {
    await writeFile(path.join(root, name), "x");
  }

  expect(await runner.execute("list_files", { path: "." })).toEqual(
    expect.arrayContaining([
      { name: "src", type: "directory" },
      { name: "README.md", type: "file" },
    ]),
  );
  expect(
    (await runner.execute("list_files", { path: "." }))
      .map((e: any) => e.name)
      .sort(),
  ).toEqual(["README.md", "src"]);
});

it("searches names and text literally, case insensitively, excluding sensitive and binary content", async () => {
  const { root, runner } = await fileFixture();

  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "hidden.txt"), "a.b");
  await writeFile(path.join(root, "A.B.txt"), "first\nA.B\naxb");
  await writeFile(path.join(root, ".env"), "a.b");
  await writeFile(path.join(root, "binary.bin"), "\0a.b");
  const result = await runner.execute("search", { path: ".", query: "a.b" });

  expect(result.matches).toEqual([
    { path: "A.B.txt", kind: "filename" },
    { path: "A.B.txt", line: 2, text: "A.B" },
  ]);
  expect(result.truncated).toBe(false);
});

it("never exceeds the search result limit when a filename fills the last slot", async () => {
  const { root, runner } = await fileFixture();

  await writeFile(
    path.join(root, "a.txt"),
    Array(99).fill("needle").join("\n"),
  );
  await writeFile(path.join(root, "b-needle.txt"), "needle");
  const result = await runner.execute("search", { path: ".", query: "needle" });

  expect(result.matches).toHaveLength(100);
  expect(result.truncated).toBe(true);
});

it("reads focused numbered lines and describes pagination when a request reaches the cap", async () => {
  const { root, runner } = await fileFixture();

  await writeFile(
    path.join(root, "lines.txt"),
    Array.from({ length: 600 }, (_, i) => `line${i + 1}`).join("\n"),
  );

  expect(
    (
      await runner.execute("read_file", {
        path: "lines.txt",
        startLine: 2,
        endLine: 3,
      })
    ).text,
  ).toBe("2: line2\n3: line3");

  const capped = await runner.execute("read_file", {
    path: "lines.txt",
    startLine: 1,
    endLine: 600,
  });

  expect(capped.text.split("\n")).toHaveLength(500);
  expect(capped).toMatchObject({
    totalLines: 600,
    returnedEndLine: 500,
    truncated: true,
    hasMore: true,
    nextStartLine: 501,
  });

  const finalPage = await runner.execute("read_file", {
    path: "lines.txt",
    startLine: 501,
    endLine: 600,
  });

  expect(finalPage).toMatchObject({
    returnedEndLine: 600,
    truncated: false,
    hasMore: false,
    nextStartLine: null,
  });
});

it("tells the model to locate content before using a focused file range", () => {
  const readFile = definitions.find(
    (definition) => definition.name === "read_file",
  );

  expect(readFile?.description).toContain("Use search to locate");
  expect(readFile?.description).toContain("normally request 80-200 lines");
  expect(readFile?.description).toContain("Maximum 500 lines");
});

it("rejects reversed line ranges instead of claiming a successful empty read", async () => {
  const { root, runner } = await fileFixture();

  await writeFile(path.join(root, "a.txt"), "one\ntwo");

  await expect(
    runner.execute("read_file", { path: "a.txt", startLine: 2, endLine: 1 }),
  ).rejects.toThrow();
});

it("rejects binary and oversized reads", async () => {
  const { root, runner } = await fileFixture();

  await writeFile(path.join(root, "binary"), "a\0b");
  await writeFile(
    path.join(root, "large"),
    Buffer.alloc(2 * 1024 * 1024 + 1, 65),
  );
  for (const name of ["binary", "large"]) {
    await expect(
      runner.execute("read_file", { path: name, startLine: 1, endLine: 5 }),
    ).rejects.toThrow();
  }
});

it("rejects missing or ambiguous replacement targets without changing the file", async () => {
  const { root, runner } = await fileFixture();

  await runner.execute("write_file", { path: "a.txt", content: "same same" });
  for (const oldText of ["absent", "same"]) {
    await expect(
      editSingleFile(runner, "a.txt", [{ oldText, newText: "new" }]),
    ).rejects.toThrow("精确匹配一次");
  }

  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("same same");
});

it("creates nested files and treats replacement dollar sequences literally", async () => {
  const { root, runner } = await fileFixture();

  await runner.execute("write_file", { path: "src/a.txt", content: "before" });
  await editSingleFile(runner, "src/a.txt", [
    { oldText: "before", newText: "$&-$1" },
  ]);

  expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("$&-$1");
  expect(await readdir(path.join(root, "src"))).toEqual(["a.txt"]);
});

it("denying a complete overwrite leaves original content intact", async () => {
  const { root, runner, approvals } = await fileFixture();

  await runner.execute("write_file", { path: "a.txt", content: "before" });
  const pending = runner.execute("write_file", {
    path: "a.txt",
    content: "after",
  });

  await expect.poll(() => approvals.list().length).toBe(1);
  approvals.decide(approvals.list()[0].id, "deny");

  await expect(pending).rejects.toThrow("拒绝");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before");
});

it("detects a file changed while overwrite approval was pending", async () => {
  const { root, runner, approvals } = await fileFixture();

  await runner.execute("write_file", { path: "a.txt", content: "before" });
  const pending = runner.execute("write_file", {
    path: "a.txt",
    content: "after",
  });

  await expect.poll(() => approvals.list().length).toBe(1);
  await writeFile(path.join(root, "a.txt"), "external");
  approvals.decide(approvals.list()[0].id, "once");

  await expect(pending).rejects.toThrow("已变化");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("external");
});

it("requires approval for project instruction edits and sensitive reads", async () => {
  const { root, runner, approvals } = await fileFixture();

  await writeFile(path.join(root, ".env"), "secret");
  for (const [name, args] of [
    ["write_file", { path: "AGENTS.md", content: "rules" }],
    ["read_file", { path: ".env", startLine: 1, endLine: 3 }],
  ] as const) {
    const pending = runner.execute(name, args);

    await expect.poll(() => approvals.list().length).toBe(1);
    approvals.decide(approvals.list()[0].id, "deny");

    await expect(pending).rejects.toThrow("拒绝");
  }
});

it("rejects unknown tools and invalid arguments before any side effects", async () => {
  const { root, runner, approvals } = await fileFixture();

  await expect(runner.execute("not_a_tool", {})).rejects.toThrow("未知工具");
  await expect(
    runner.execute("write_file", { path: "a", content: "x", extra: true }),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  expect(approvals.list()).toEqual([]);
});

it("applies multiple edits from one snapshot and allows another edit without rereading", async () => {
  const { root, runner } = await fileFixture();
  await runner.execute("write_file", {
    path: "a.txt",
    content: "alpha middle omega",
  });
  await editSingleFile(runner, "a.txt", [
    { oldText: "alpha", newText: "$&" },
    { oldText: "omega", newText: "last" },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "$& middle last",
  );
  await editSingleFile(runner, "a.txt", [
    { oldText: "middle", newText: "center" },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "$& center last",
  );
});

it("leaves the file and read state intact when a later edit fails", async () => {
  const { root, runner } = await fileFixture();
  await runner.execute("write_file", {
    path: "a.txt",
    content: "alpha same same",
  });
  for (const oldText of ["absent", "same"]) {
    await expect(
      editSingleFile(runner, "a.txt", [
        { oldText: "alpha", newText: "changed" },
        { oldText, newText: "x" },
      ]),
    ).rejects.toThrow("精确匹配一次");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
      "alpha same same",
    );
  }

  await expect(
    runner.execute("edit_files", { files: [{ path: "a.txt", edits: [] }] }),
  ).rejects.toThrow();
  await editSingleFile(runner, "a.txt", [{ oldText: "alpha", newText: "ok" }]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("ok same same");
  expect(await readdir(root)).toEqual(["a.txt"]);
});
