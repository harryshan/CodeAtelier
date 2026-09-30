/**
 * 通过 fileFixture 调用真实 ToolRunner，检查文件工具的结果和磁盘上的变化。
 * 所有文件都建在临时目录，审批由用例明确处理。
 *
 * 1. 检查已移除目录/搜索工具的拒绝，以及带行号、分页、版本和可见空白元数据的分段读取。
 * 2. 检查模型可见的定位/小范围读取契约，以及反向行区间、二进制文件和过大文件被拒绝。
 * 3. 检查已有文件成功编辑后必须重新读取、显式新建父目录、美元符号按原文替换，以及 create 防止覆盖。
 * 4. 在等待审批时修改文件，并检查规则文件、敏感文件和非法工具参数的处理。
 *
 * 拒绝或校验失败后，原文件必须保持不变，不能只检查是否弹出了审批。
 */

import { it, expect } from "vitest";
import { writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { definitions } from "../src/tools/registry.js";
import type { ToolRunner } from "../src/tools/tool-runner.js";
import { fileFixture } from "./fixtures/helpers.js";

/** 将单文件场景包装为唯一 edit_files 工具所需的 files 数组。 */
async function editSingleFile(runner: ToolRunner, path: string, edits: any[]) {
  const result = await runner.execute("edit_files", {
    files: [{ path, create: false, edits }],
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return result;
}

async function createFile(runner: ToolRunner, path: string, content: string) {
  const result = await runner.execute("edit_files", {
    files: [{ path, create: true, content }],
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return result;
}

it("does not expose retired directory, write, or search tools and rejects direct calls", async () => {
  const { runner } = await fileFixture();

  for (const name of ["list_files", "write_file", "search"]) {
    expect(definitions.map((definition) => definition.name)).not.toContain(
      name,
    );
    await expect(runner.execute(name, {})).rejects.toThrow("未知工具");
  }
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

it("returns a copyable source view and optional visible whitespace diagnostics", async () => {
  const { root, runner } = await fileFixture();
  await writeFile(path.join(root, "spaces.txt"), "  alpha\t\r\n");

  const result = await runner.execute("read_file", {
    path: "spaces.txt",
    startLine: 1,
    endLine: 1,
    whitespaceMode: true,
  });

  expect(result.text).toBe("1:   alpha\t\r");
  expect(result.visibleText).toBe("1: ··alpha→␍↵");
  expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
});

it("tells the model to use a command search before using a focused file range", () => {
  const readFile = definitions.find(
    (definition) => definition.name === "read_file",
  );

  expect(readFile?.description).toContain(
    "Use run_command with an environment-detected search command to locate",
  );
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

it("creates nested files and treats replacement dollar sequences literally", async () => {
  const { root, runner } = await fileFixture();

  await createFile(runner, "src/a.txt", "before");
  await editSingleFile(runner, "src/a.txt", [
    { oldText: "before", newText: "$&-$1" },
  ]);

  expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("$&-$1");
  expect(await readdir(path.join(root, "src"))).toEqual(["a.txt"]);
});

it("rejects binary content for a new file before creating it", async () => {
  const { root, runner } = await fileFixture();

  const result = await runner.execute("edit_files", {
    files: [{ path: "binary.txt", create: true, content: "a\0b" }],
  });

  expect(result.files).toMatchObject([
    { path: "binary.txt", status: "failed" },
  ]);
  expect(result.error).toContain("NUL");
  await expect(readFile(path.join(root, "binary.txt"))).rejects.toThrow();
});

it("rejects create when the target already exists without replacing it", async () => {
  const { root, runner } = await fileFixture();

  await createFile(runner, "a.txt", "before");
  const result = await runner.execute("edit_files", {
    files: [{ path: "a.txt", create: true, content: "after" }],
  });

  expect(result.files).toMatchObject([{ path: "a.txt", status: "failed" }]);
  expect(result.error).toContain("已存在");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before");
});

it("rejects a file that appears after create preflight", async () => {
  const { root, runner, approvals } = await fileFixture();
  await writeFile(path.join(root, "AGENTS.md"), "rules");
  await runner.execute("read_file", {
    path: "AGENTS.md",
    startLine: 1,
    endLine: 1,
  });

  const pending = runner.execute("edit_files", {
    files: [
      { path: "a.txt", create: true, content: "after" },
      {
        path: "AGENTS.md",
        create: false,
        edits: [{ oldText: "rules", newText: "updated" }],
      },
    ],
  });

  await expect.poll(() => approvals.list()).toHaveLength(1);
  await writeFile(path.join(root, "a.txt"), "external");
  approvals.decide(approvals.list()[0].id, "once");
  const result = await pending;

  expect(result.error).toContain("出现");
  expect(result.files).toMatchObject([
    { path: "a.txt", status: "failed" },
    { path: "AGENTS.md", status: "written" },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("external");
});

it("requires approval for project instruction edits and sensitive reads", async () => {
  const { root, runner, approvals } = await fileFixture();

  await writeFile(path.join(root, ".env"), "secret");
  for (const [name, args] of [
    [
      "edit_files",
      { files: [{ path: "AGENTS.md", create: true, content: "rules" }] },
    ],
    ["read_file", { path: ".env", startLine: 1, endLine: 3 }],
  ] as const) {
    const pending = runner.execute(name, args);

    await expect.poll(() => approvals.list().length).toBe(1);
    approvals.decide(approvals.list()[0].id, "deny");

    if (name === "edit_files") {
      expect((await pending).error).toContain("拒绝");
    } else {
      await expect(pending).rejects.toThrow("拒绝");
    }
  }
});

it("rejects unknown tools and invalid arguments before any side effects", async () => {
  const { root, runner, approvals } = await fileFixture();

  await expect(runner.execute("not_a_tool", {})).rejects.toThrow("未知工具");
  await expect(
    runner.execute("edit_files", {
      files: [{ path: "a", create: true, content: "x", extra: true }],
    }),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  expect(approvals.list()).toEqual([]);
});

it("requires a reread after successfully editing an existing file", async () => {
  const { root, runner } = await fileFixture();
  await createFile(runner, "a.txt", "alpha middle omega");
  await editSingleFile(runner, "a.txt", [
    { oldText: "alpha", newText: "$&" },
    { oldText: "omega", newText: "last" },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "$& middle last",
  );
  await expect(
    editSingleFile(runner, "a.txt", [{ oldText: "middle", newText: "center" }]),
  ).rejects.toThrow("未读取");
  await runner.execute("read_file", {
    path: "a.txt",
    startLine: 1,
    endLine: 1,
  });
  await editSingleFile(runner, "a.txt", [
    { oldText: "middle", newText: "center" },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "$& center last",
  );
});

it("leaves the file and read state intact when a later edit fails", async () => {
  const { root, runner } = await fileFixture();
  await createFile(runner, "a.txt", "alpha same same");
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
    runner.execute("edit_files", {
      files: [{ path: "a.txt", create: false, edits: [] }],
    }),
  ).rejects.toThrow();
  await editSingleFile(runner, "a.txt", [{ oldText: "alpha", newText: "ok" }]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("ok same same");
  expect(await readdir(root)).toEqual(["a.txt"]);
});
