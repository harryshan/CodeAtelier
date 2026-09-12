/**
 * 文件作用：验证文件工具的读取、搜索、修改和审批边界。
 *
 * 使用场景与输入输出：
 * 通过 fileFixture 运行生产 ToolRunner，使用临时文件及待审批对象验证实际磁盘变化和返回数据。
 *
 * 代码结构与阅读顺序：
 * 1. 读取部分覆盖目录过滤、大小写不敏感的字面搜索、结果限额与带行号范围。
 * 2. 失败部分验证反向行区间、二进制及大文件不被误报为正常读取。
 * 3. 写入部分覆盖唯一替换、新建父目录、美元替换字面量及完整覆盖审批。
 * 4. 并发和安全部分在等待审批时修改文件，检查规则文件、敏感读取及未知工具参数。
 *
 * 维护注意事项：
 * 拒绝或校验失败必须保持原文件；用例验证结果和副作用，不只断言请求过审批。
 */

import { it, expect } from "vitest";
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileFixture } from "./fixtures/helpers.js";

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

it("reads requested numbered lines and caps a large range at 2000 lines", async () => {
  const { root, runner } = await fileFixture();

  await writeFile(
    path.join(root, "lines.txt"),
    Array.from({ length: 2100 }, (_, i) => `line${i + 1}`).join("\n"),
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
  expect(
    (
      await runner.execute("read_file", {
        path: "lines.txt",
        startLine: 1,
        endLine: 2100,
      })
    ).text.split("\n"),
  ).toHaveLength(2000);
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
      runner.execute("edit_file", { path: "a.txt", oldText, newText: "new" }),
    ).rejects.toThrow("精确匹配一次");
  }

  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("same same");
});

it("creates nested files and treats replacement dollar sequences literally", async () => {
  const { root, runner } = await fileFixture();

  await runner.execute("write_file", { path: "src/a.txt", content: "before" });
  await runner.execute("edit_file", {
    path: "src/a.txt",
    oldText: "before",
    newText: "$&-$1",
  });

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
