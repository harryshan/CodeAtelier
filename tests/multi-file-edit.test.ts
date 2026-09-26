/**
 * 使用真实 ToolRunner 和临时文件验证统一文件编辑工具，不访问模型或用户项目。
 * 1. 最后一次预检后的新建竞争也不得覆盖外部文件；单/多文件编辑、后项校验失败、重复路径和读取版本通过磁盘内容验证。
 * 2. 行号限定搜索窗口，覆盖行内/跨行片段、重复文本、原始快照偏移、范围越界、重叠、所有文本文件的 CRLF/LF 等价定位、唯一空白候选和可修复诊断。
 * 3. 后续故障用例检查逐文件失败仍继续、版本校验、聚合错误、取消及部分写入，不假设跨文件原子性；夹具统一关闭其按需创建的读取线程。
 */

import { expect, it, vi, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as fs from "node:fs/promises";
import { writeFileSync, renameSync, linkSync, type PathLike } from "node:fs";
import { ToolRunner } from "../src/tools/tool-runner.js";
import { fileFixture, trackRunner } from "./fixtures/helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...original,
    rename: vi.fn(original.rename),
    link: vi.fn(original.link),
    copyFile: vi.fn(original.copyFile),
  };
});

it.each([false, true])(
  "creates safely without hard-link support, competing target=%s",
  async (competingTarget) => {
    const { root, runner } = await fileFixture();
    const target = path.join(root, "portable.txt");
    vi.spyOn(fs, "link").mockImplementationOnce(async () => {
      if (competingTarget) {
        await writeFile(target, "external contents", { flag: "wx" });
      }

      throw Object.assign(new Error("hard links unsupported"), {
        code: "ENOTSUP",
      });
    });
    const result = await runner.execute("edit_files", {
      files: [
        { path: "portable.txt", create: true, content: "agent contents" },
      ],
    });

    expect(await readFile(target, "utf8")).toBe(
      competingTarget ? "external contents" : "agent contents",
    );
    expect(result.files[0].status).toBe(
      competingTarget ? "unknown" : "written",
    );
    expect(await fs.readdir(root)).toEqual(["portable.txt"]);
  },
);

it("preserves a file created after the final create preflight", async () => {
  const { root, runner } = await fileFixture();
  const target = path.join(root, "raced.txt");
  const collide = (
    source: PathLike,
    destination: PathLike,
    publish: typeof renameSync,
  ) => {
    writeFileSync(target, "external contents", { flag: "wx" });
    publish(source, destination);
  };

  vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
    collide(source, destination, renameSync);
  });
  vi.spyOn(fs, "link").mockImplementationOnce(async (source, destination) => {
    collide(source, destination, linkSync);
  });

  const result = await runner.execute("edit_files", {
    files: [{ path: "raced.txt", create: true, content: "agent contents" }],
  });

  expect(await readFile(target, "utf8")).toBe("external contents");
  expect(result.error).toBeTruthy();
  expect(result.files[0].status).not.toBe("written");
  expect(await fs.readdir(root)).toEqual(["raced.txt"]);
});

/** 用统一工具的一个 files 条目覆盖单文件场景，并将该文件的失败恢复为测试断言需要的异常。 */
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

it("edits two files in one call and reports each completed file", async () => {
  const { root, runner, events } = await fileFixture();
  for (const name of ["a.txt", "b.txt"]) {
    await createFile(runner, name, "old");
  }

  events.length = 0;

  const result = await runner.execute("edit_files", {
    files: ["a.txt", "b.txt"].map((name) => ({
      path: name,
      create: false,
      edits: [{ oldText: "old", newText: "new" }],
    })),
  });
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "written",
  ]);
  for (const name of ["a.txt", "b.txt"]) {
    expect(await readFile(path.join(root, name), "utf8")).toBe("new");
  }

  expect(
    events.filter(
      (event) =>
        event.type === "edit_progress" && event.data.status === "written",
    ),
  ).toHaveLength(2);
});

it("writes valid files when a later file fails preflight", async () => {
  const { root, runner } = await fileFixture();
  for (const name of ["a.txt", "b.txt"]) {
    await createFile(runner, name, "old");
  }

  const result = await runner.execute("edit_files", {
    files: [
      {
        path: "a.txt",
        create: false,
        edits: [{ oldText: "old", newText: "new" }],
      },
      {
        path: "b.txt",
        create: false,
        edits: [{ oldText: "missing", newText: "new" }],
      },
    ],
  });
  expect(result.error).toContain("b.txt");
  expect(result.error).toContain("精确匹配一次");
  expect(result.files).toMatchObject([
    { path: "a.txt", status: "written" },
    { path: "b.txt", status: "failed" },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("old");
});

it("reports every preflight failure while writing independent valid files", async () => {
  const { root, runner } = await fileFixture();
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await createFile(runner, name, "old");
  }

  const result = await runner.execute("edit_files", {
    files: [
      {
        path: "a.txt",
        create: false,
        edits: [{ oldText: "old", newText: "new" }],
      },
      {
        path: "b.txt",
        create: false,
        edits: [{ oldText: "missing-b", newText: "new" }],
      },
      {
        path: "c.txt",
        create: false,
        edits: [{ oldText: "missing-c", newText: "new" }],
      },
    ],
  });

  expect(result.error).toContain("b.txt");
  expect(result.error).toContain("c.txt");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "failed",
    "failed",
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("old");
  expect(await readFile(path.join(root, "c.txt"), "utf8")).toBe("old");
});

it("uses original line ranges to disambiguate repeated text despite earlier inserted lines", async () => {
  const { root, runner } = await fileFixture();
  await createFile(runner, "a.txt", "same\nsame\ntail\n");
  await editSingleFile(runner, "a.txt", [
    { oldText: "same", newText: "first\nextra", startLine: 1, endLine: 1 },
    { oldText: "same", newText: "second", startLine: 2, endLine: 2 },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "first\nextra\nsecond\ntail\n",
  );
});

it("rejects wrong lines and overlapping replacements without changing content", async () => {
  const { root, runner } = await fileFixture();
  await createFile(runner, "a.txt", "alpha\nbeta");
  for (const edits of [
    [{ oldText: "alpha", newText: "x", startLine: 2, endLine: 2 }],
    [{ oldText: "alpha", newText: "x", startLine: 1, endLine: null }],
    [
      { oldText: "alpha", newText: "x" },
      { oldText: "lph", newText: "y" },
    ],
  ]) {
    await expect(editSingleFile(runner, "a.txt", edits)).rejects.toThrow();
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
      "alpha\nbeta",
    );
  }
});

it("rejects aliases of one file and stale read versions before writing", async () => {
  const { root, runner } = await fileFixture();
  await createFile(runner, "a.txt", "old");
  const duplicate = await runner.execute("edit_files", {
    files: ["a.txt", "./a.txt"].map((name) => ({
      path: name,
      create: false,
      edits: [{ oldText: "old", newText: "new" }],
    })),
  });
  expect(duplicate.error).toContain("重复");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("old");
  await writeFile(path.join(root, "a.txt"), "external");
  const stale = await runner.execute("edit_files", {
    files: [
      {
        path: "a.txt",
        create: false,
        edits: [{ oldText: "external", newText: "new" }],
      },
    ],
  });
  expect(stale.error).toContain("已变化");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("external");
});

// 故障钩子只在夹具目录和同步进度回调中触发；不修改生产执行路径。
afterEach(() => vi.restoreAllMocks());

async function hookedFixture(
  hook: (data: any, root: string, controller: AbortController) => void,
) {
  const fixture = await fileFixture();
  const runner = trackRunner(
    new ToolRunner({
      root: fixture.root,
      settings: fixture.config.settings,
      signal: fixture.controller.signal,
      approvals: fixture.approvals,
      sessionId: "s",
      taskId: "t",
      emit: (type, data) => {
        fixture.events.push({ type, data });
        if (type === "edit_progress") {
          hook(data, fixture.root, fixture.controller);
        }
      },
    }),
  );
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await writeFile(path.join(fixture.root, name), "old");
    await runner.execute("read_file", {
      path: name,
      startLine: 1,
      endLine: 1,
    });
  }

  return { ...fixture, runner };
}

const threeFiles = {
  files: ["a.txt", "b.txt", "c.txt"].map((name) => ({
    path: name,
    create: false,
    edits: [{ oldText: "old", newText: "new" }],
  })),
};

it("preserves completed files and continues when another file changes during the batch", async () => {
  const { runner, root } = await hookedFixture((event, directory) => {
    if (event.path === "a.txt" && event.status === "written") {
      writeFileSync(path.join(directory, "b.txt"), "external");
    }
  });
  const result = await runner.execute("edit_files", threeFiles);
  expect(result.error).toContain("b.txt");
  expect(result.error).toContain("已变化");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "failed",
    "written",
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("external");
  expect(await readFile(path.join(root, "c.txt"), "utf8")).toBe("new");
});

it("keeps per-file progress and stops after cancellation", async () => {
  const { runner, root, events } = await hookedFixture(
    (event, _, controller) => {
      if (event.path === "a.txt" && event.status === "written") {
        controller.abort(new Error("cancelled"));
      }
    },
  );
  const result = await runner.execute("edit_files", threeFiles);
  expect(result.error).toContain("cancelled");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "not_attempted",
    "not_attempted",
  ]);
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("old");
  expect(
    events.some(
      (event) =>
        event.type === "edit_progress" &&
        event.data.path === "a.txt" &&
        event.data.status === "written",
    ),
  ).toBe(true);
});

it("reports uncertainty after a write error while continuing other files", async () => {
  const { runner, root } = await hookedFixture((event) => {
    if (event.path === "b.txt" && event.status === "unknown" && !event.error) {
      vi.spyOn(fs, "rename")
        .mockRejectedValueOnce(new Error("disk failure"))
        .mockImplementation(async (source, target) => {
          renameSync(source, target);
        });
    }
  });
  const result = await runner.execute("edit_files", threeFiles);
  expect(result.error).toContain("disk failure");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "unknown",
    "written",
  ]);
  expect(result.error).toContain("b.txt");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("old");
  expect(await readFile(path.join(root, "c.txt"), "utf8")).toBe("new");
  expect((await fs.readdir(root)).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
});

it("writes ordinary files when protected-file approval is denied", async () => {
  const { runner, root, approvals } = await fileFixture();
  await createFile(runner, "a.txt", "old");
  await writeFile(path.join(root, "AGENTS.md"), "rules");
  await runner.execute("read_file", {
    path: "AGENTS.md",
    startLine: 1,
    endLine: 1,
  });
  const pending = runner.execute("edit_files", {
    files: [
      {
        path: "a.txt",
        create: false,
        edits: [{ oldText: "old", newText: "new" }],
      },
      {
        path: "AGENTS.md",
        create: false,
        edits: [{ oldText: "rules", newText: "changed" }],
      },
    ],
  });
  await expect.poll(() => approvals.list().length).toBe(1);
  approvals.decide(approvals.list()[0].id, "deny");
  const result = await pending;
  expect(result.error).toContain("AGENTS.md");
  expect(result.error).toContain("拒绝");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "failed",
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("rules");
});

it("matches complete CRLF ranges and preserves the terminal newline", async () => {
  const { runner, root } = await fileFixture();
  await createFile(runner, "a.txt", "one\r\ntwo\r\nthree\r\n");
  await editSingleFile(runner, "a.txt", [
    { oldText: "one\r\ntwo", newText: "first", startLine: 1, endLine: 2 },
    { oldText: "three", newText: "last", startLine: 3, endLine: 3 },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "first\r\nlast\r\n",
  );
});

it("rejects cascade targets and overlapping textual occurrences in the original snapshot", async () => {
  const { runner, root } = await fileFixture();
  await createFile(runner, "a.txt", "aaa alpha");
  for (const edits of [
    [
      { oldText: "alpha", newText: "first" },
      { oldText: "first", newText: "second" },
    ],
    [{ oldText: "aa", newText: "x" }],
    [{ oldText: "aaa", newText: "x", startLine: 1, endLine: 2 }],
  ]) {
    await expect(editSingleFile(runner, "a.txt", edits)).rejects.toThrow();
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("aaa alpha");
  }
});

it("rechecks earlier snapshots after a later approval completes", async () => {
  const { runner, root, approvals } = await fileFixture();
  await createFile(runner, "a.txt", "old");
  await writeFile(path.join(root, "AGENTS.md"), "rules");
  await runner.execute("read_file", {
    path: "AGENTS.md",
    startLine: 1,
    endLine: 1,
  });
  const pending = runner.execute("edit_files", {
    files: [
      {
        path: "a.txt",
        create: false,
        edits: [{ oldText: "old", newText: "new" }],
      },
      {
        path: "AGENTS.md",
        create: false,
        edits: [{ oldText: "rules", newText: "changed" }],
      },
    ],
  });
  await expect.poll(() => approvals.list().length).toBe(1);
  await writeFile(path.join(root, "a.txt"), "external");
  approvals.decide(approvals.list()[0].id, "once");
  const result = await pending;
  expect(result.error).toContain("a.txt");
  expect(result.error).toContain("已变化");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "failed",
    "written",
  ]);
  expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("changed");
});

it("stops before the next file if saving a completed progress event fails", async () => {
  const { runner, root } = await hookedFixture((event) => {
    if (event.path === "a.txt" && event.status === "written") {
      throw new Error("history write failed");
    }
  });
  await expect(runner.execute("edit_files", threeFiles)).rejects.toThrow(
    "history write failed",
  );
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("old");
});

it("uses line ranges as search windows and preserves surrounding text", async () => {
  const { runner, root } = await fileFixture();
  await createFile(
    runner,
    "a.txt",
    "  const timeout = 1000;\n  const retry = 1000;\n",
  );
  await editSingleFile(runner, "a.txt", [
    { oldText: "1000", newText: "2000", startLine: 1, endLine: 1 },
    { oldText: "retry", newText: "attempts", startLine: 2, endLine: 2 },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "  const timeout = 2000;\n  const attempts = 1000;\n",
  );
});

it("accepts exact snippets with or without the final line ending", async () => {
  const { runner, root } = await fileFixture();
  for (const newline of ["\n", "\r\n"]) {
    const name = newline.length === 1 ? "lf.txt" : "crlf.txt";
    await createFile(
      runner,
      name,
      `prefix first${newline}second suffix${newline}tail`,
    );
    await editSingleFile(runner, name, [
      {
        oldText: `first${newline}second`,
        newText: "joined",
        startLine: 1,
        endLine: 2,
      },
      {
        oldText: ` suffix${newline}`,
        newText: newline,
        startLine: 2,
        endLine: 2,
      },
    ]);
    expect(await readFile(path.join(root, name), "utf8")).toBe(
      `prefix joined${newline}tail`,
    );
  }
});

it("rejects missing, ambiguous, out-of-range and overlapping matches without fallback", async () => {
  const { runner, root } = await fileFixture();
  const original = "outside\naaa value value\nlast";
  await createFile(runner, "a.txt", original);
  for (const edits of [
    [{ oldText: "outside", newText: "x", startLine: 2, endLine: 2 }],
    [{ oldText: "value", newText: "x", startLine: 2, endLine: 2 }],
    [{ oldText: "aa", newText: "x", startLine: 2, endLine: 2 }],
    [{ oldText: "value\nlast", newText: "x", startLine: 2, endLine: 2 }],
    [
      { oldText: "aaa", newText: "x", startLine: 2, endLine: 2 },
      { oldText: "aaa value", newText: "y", startLine: 1, endLine: 3 },
    ],
  ]) {
    await expect(editSingleFile(runner, "a.txt", edits)).rejects.toThrow();
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(original);
  }
});

it("uses one whitespace-normalized candidate while retaining the real source range", async () => {
  const { runner, root } = await fileFixture();
  await createFile(
    runner,
    "a.ts",
    "const value = createTask(\r\n  input,\r\n);\r\n",
  );

  const result = await runner.execute("edit_files", {
    files: [
      {
        path: "a.ts",
        create: false,
        edits: [
          {
            oldText: "createTask(\n input,\n)",
            newText: "createTask({ input })",
            startLine: 1,
            endLine: 3,
          },
        ],
      },
    ],
  });

  expect(result.files).toMatchObject([
    { status: "written", matchModes: ["normalized_whitespace"] },
  ]);
  expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe(
    "const value = createTask({ input });\r\n",
  );
});

it("rejects ambiguous normalized candidates with candidate-line diagnostics", async () => {
  const { runner, root } = await fileFixture();
  const original = "call( 1 );\ncall( 1 );\n";
  await createFile(runner, "a.ts", original);

  const result = await runner.execute("edit_files", {
    files: [
      {
        path: "a.ts",
        create: false,
        edits: [
          { oldText: "call(1);", newText: "run();", startLine: 1, endLine: 2 },
        ],
      },
    ],
  });

  expect(result.files[0]).toMatchObject({
    status: "failed",
    diagnostic: {
      code: "EDIT_TARGET_AMBIGUOUS",
      candidateLines: [1, 2],
    },
  });
  expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe(original);
});

it("keeps whitespace-sensitive files strict and validates an explicit file version", async () => {
  const { runner, root } = await fileFixture();
  await createFile(runner, "rules.py", "if ready:\n    run()\n");
  await createFile(runner, "a.ts", "const value = 1;\n");

  const strict = await runner.execute("edit_files", {
    files: [
      {
        path: "rules.py",
        create: false,
        edits: [
          { oldText: "if ready:\n run()", newText: "if ready:\n    run()" },
        ],
      },
    ],
  });
  const staleVersion = await runner.execute("edit_files", {
    files: [
      {
        path: "a.ts",
        create: false,
        fileVersion: "0".repeat(64),
        edits: [{ oldText: "value", newText: "result" }],
      },
    ],
  });

  expect(strict.files[0]).toMatchObject({
    status: "failed",
    diagnostic: { code: "EDIT_WHITESPACE_FALLBACK_DISALLOWED" },
  });
  expect(staleVersion.files[0]).toMatchObject({
    status: "failed",
    diagnostic: { code: "EDIT_FILE_VERSION_MISMATCH" },
  });
  expect(await readFile(path.join(root, "rules.py"), "utf8")).toBe(
    "if ready:\n    run()\n",
  );
  expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe(
    "const value = 1;\n",
  );
});

it("uses scoped normalization for CRLF differences without rewriting surrounding text", async () => {
  const { runner, root } = await fileFixture();
  for (const name of ["a.txt", "b.txt"]) {
    await createFile(runner, name, "prefix one\r\ntwo suffix");
  }

  const result = await runner.execute("edit_files", {
    files: [
      {
        path: "a.txt",
        create: false,
        edits: [
          { oldText: "prefix", newText: "new", startLine: 1, endLine: 1 },
        ],
      },
      {
        path: "b.txt",
        create: false,
        edits: [
          { oldText: "one\ntwo", newText: "joined", startLine: 1, endLine: 2 },
        ],
      },
    ],
  });

  expect(result.files).toMatchObject([
    { status: "written", matchModes: ["exact"] },
    { status: "written", matchModes: ["normalized_line_endings"] },
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "new one\r\ntwo suffix",
  );
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe(
    "prefix joined suffix",
  );
});

it("matches only line-ending differences in whitespace-sensitive files and preserves their style", async () => {
  const { runner, root } = await fileFixture();
  await createFile(runner, "guide.md", "first\r\nsecond\r\nthird\r\n");
  await createFile(runner, "rules.py", "if ready:\n    run()\n");

  const result = await runner.execute("edit_files", {
    files: [
      {
        path: "guide.md",
        create: false,
        edits: [
          {
            oldText: "first\nsecond",
            newText: "first\nupdated",
            startLine: null,
            endLine: null,
          },
        ],
      },
      {
        path: "rules.py",
        create: false,
        edits: [
          {
            oldText: "if ready:\r\n    run()",
            newText: "if ready:\r\n    execute()",
            startLine: null,
            endLine: null,
          },
        ],
      },
    ],
  });

  expect(result.files).toMatchObject([
    { status: "written", matchModes: ["normalized_line_endings"] },
    { status: "written", matchModes: ["normalized_line_endings"] },
  ]);
  expect(await readFile(path.join(root, "guide.md"), "utf8")).toBe(
    "first\r\nupdated\r\nthird\r\n",
  );
  expect(await readFile(path.join(root, "rules.py"), "utf8")).toBe(
    "if ready:\n    execute()\n",
  );
});

it("rejects ambiguous line-ending matches without writing whitespace-sensitive files", async () => {
  const { runner, root } = await fileFixture();
  const original = "one\r\ntwo\r\none\r\ntwo\r\n";
  await createFile(runner, "guide.md", original);

  const result = await runner.execute("edit_files", {
    files: [
      {
        path: "guide.md",
        create: false,
        edits: [
          {
            oldText: "one\ntwo",
            newText: "updated",
            startLine: null,
            endLine: null,
          },
        ],
      },
    ],
  });

  expect(result.files[0]).toMatchObject({
    status: "failed",
    diagnostic: {
      code: "EDIT_TARGET_AMBIGUOUS",
      candidateLines: [1, 3],
    },
  });
  expect(await readFile(path.join(root, "guide.md"), "utf8")).toBe(original);
});
