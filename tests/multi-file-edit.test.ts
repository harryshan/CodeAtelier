/**
 * 使用真实 ToolRunner 和临时文件验证多文件编辑，不访问模型或用户项目。
 * 1. 整批成功、后项校验失败、重复路径以及读取版本检查通过磁盘内容验证。
 * 2. 行号限定搜索窗口，覆盖行内/跨行片段、重复文本、原始快照偏移、范围越界、重叠和 CRLF 边界。
 * 3. 后续故障用例检查逐文件进度、取消及部分写入，不假设跨文件原子性。
 */

import { expect, it, vi, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { ToolRunner } from "../src/tools/tool-runner.js";
import { fileFixture } from "./fixtures/helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();

  return { ...original, rename: vi.fn(original.rename) };
});

it("edits two files in one call and reports each completed file", async () => {
  const { root, runner, events } = await fileFixture();
  for (const name of ["a.txt", "b.txt"]) {
    await runner.execute("write_file", { path: name, content: "old" });
  }

  const result = await runner.execute("edit_files", {
    files: ["a.txt", "b.txt"].map((name) => ({
      path: name,
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

it("does not write any file when a later file fails preflight", async () => {
  const { root, runner } = await fileFixture();
  for (const name of ["a.txt", "b.txt"]) {
    await runner.execute("write_file", { path: name, content: "old" });
  }

  const result = await runner.execute("edit_files", {
    files: [
      { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
      { path: "b.txt", edits: [{ oldText: "missing", newText: "new" }] },
    ],
  });
  expect(result.error).toContain("精确匹配一次");
  expect(
    result.files.every((file: any) => file.status === "not_attempted"),
  ).toBe(true);
  for (const name of ["a.txt", "b.txt"]) {
    expect(await readFile(path.join(root, name), "utf8")).toBe("old");
  }
});

it("uses original line ranges to disambiguate repeated text despite earlier inserted lines", async () => {
  const { root, runner } = await fileFixture();
  await runner.execute("write_file", {
    path: "a.txt",
    content: "same\nsame\ntail\n",
  });
  await runner.execute("edit_file", {
    path: "a.txt",
    edits: [
      { oldText: "same", newText: "first\nextra", startLine: 1, endLine: 1 },
      { oldText: "same", newText: "second", startLine: 2, endLine: 2 },
    ],
  });
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "first\nextra\nsecond\ntail\n",
  );
});

it("rejects wrong lines and overlapping replacements without changing content", async () => {
  const { root, runner } = await fileFixture();
  await runner.execute("write_file", { path: "a.txt", content: "alpha\nbeta" });
  for (const edits of [
    [{ oldText: "alpha", newText: "x", startLine: 2, endLine: 2 }],
    [{ oldText: "alpha", newText: "x", startLine: 1, endLine: null }],
    [
      { oldText: "alpha", newText: "x" },
      { oldText: "lph", newText: "y" },
    ],
  ]) {
    await expect(
      runner.execute("edit_file", { path: "a.txt", edits }),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
      "alpha\nbeta",
    );
  }
});

it("rejects aliases of one file and stale read versions before writing", async () => {
  const { root, runner } = await fileFixture();
  await runner.execute("write_file", { path: "a.txt", content: "old" });
  const duplicate = await runner.execute("edit_files", {
    files: ["a.txt", "./a.txt"].map((name) => ({
      path: name,
      edits: [{ oldText: "old", newText: "new" }],
    })),
  });
  expect(duplicate.error).toContain("重复");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("old");
  await writeFile(path.join(root, "a.txt"), "external");
  const stale = await runner.execute("edit_files", {
    files: [
      { path: "a.txt", edits: [{ oldText: "external", newText: "new" }] },
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
  const runner = new ToolRunner({
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
  });
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await runner.execute("write_file", { path: name, content: "old" });
  }

  return { ...fixture, runner };
}

const threeFiles = {
  files: ["a.txt", "b.txt", "c.txt"].map((name) => ({
    path: name,
    edits: [{ oldText: "old", newText: "new" }],
  })),
};

it("preserves completed files and stops when another file changes during the batch", async () => {
  const { runner, root } = await hookedFixture((event, directory) => {
    if (event.path === "a.txt" && event.status === "written") {
      writeFileSync(path.join(directory, "b.txt"), "external");
    }
  });
  const result = await runner.execute("edit_files", threeFiles);
  expect(result.error).toContain("已变化");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "not_attempted",
    "not_attempted",
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("external");
  expect(await readFile(path.join(root, "c.txt"), "utf8")).toBe("old");
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

it("reports uncertainty after a write error without replaying or rolling back", async () => {
  const { runner, root } = await hookedFixture((event) => {
    if (event.path === "b.txt" && event.status === "unknown") {
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    }
  });
  const result = await runner.execute("edit_files", threeFiles);
  expect(result.error).toContain("disk failure");
  expect(result.files.map((file: any) => file.status)).toEqual([
    "written",
    "unknown",
    "not_attempted",
  ]);
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
  expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("old");
  expect(await readFile(path.join(root, "c.txt"), "utf8")).toBe("old");
  expect((await fs.readdir(root)).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
});

it("does not write earlier files when protected-file approval is denied", async () => {
  const { runner, root, approvals } = await fileFixture();
  await runner.execute("write_file", { path: "a.txt", content: "old" });
  await writeFile(path.join(root, "AGENTS.md"), "rules");
  await runner.execute("read_file", {
    path: "AGENTS.md",
    startLine: 1,
    endLine: 1,
  });
  const pending = runner.execute("edit_files", {
    files: [
      { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
      { path: "AGENTS.md", edits: [{ oldText: "rules", newText: "changed" }] },
    ],
  });
  await expect.poll(() => approvals.list().length).toBe(1);
  approvals.decide(approvals.list()[0].id, "deny");
  expect((await pending).error).toContain("拒绝");
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("old");
  expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("rules");
});

it("matches complete CRLF ranges and preserves the terminal newline", async () => {
  const { runner, root } = await fileFixture();
  await runner.execute("write_file", {
    path: "a.txt",
    content: "one\r\ntwo\r\nthree\r\n",
  });
  await runner.execute("edit_file", {
    path: "a.txt",
    edits: [
      { oldText: "one\r\ntwo", newText: "first", startLine: 1, endLine: 2 },
      { oldText: "three", newText: "last", startLine: 3, endLine: 3 },
    ],
  });
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "first\r\nlast\r\n",
  );
});

it("rejects cascade targets and overlapping textual occurrences in the original snapshot", async () => {
  const { runner, root } = await fileFixture();
  await runner.execute("write_file", { path: "a.txt", content: "aaa alpha" });
  for (const edits of [
    [
      { oldText: "alpha", newText: "first" },
      { oldText: "first", newText: "second" },
    ],
    [{ oldText: "aa", newText: "x" }],
    [{ oldText: "aaa", newText: "x", startLine: 1, endLine: 2 }],
  ]) {
    await expect(
      runner.execute("edit_file", { path: "a.txt", edits }),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("aaa alpha");
  }
});

it("rechecks earlier snapshots after a later approval completes", async () => {
  const { runner, root, approvals } = await fileFixture();
  await runner.execute("write_file", { path: "a.txt", content: "old" });
  await writeFile(path.join(root, "AGENTS.md"), "rules");
  await runner.execute("read_file", {
    path: "AGENTS.md",
    startLine: 1,
    endLine: 1,
  });
  const pending = runner.execute("edit_files", {
    files: [
      { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
      { path: "AGENTS.md", edits: [{ oldText: "rules", newText: "changed" }] },
    ],
  });
  await expect.poll(() => approvals.list().length).toBe(1);
  await writeFile(path.join(root, "a.txt"), "external");
  approvals.decide(approvals.list()[0].id, "once");
  const result = await pending;
  expect(result.error).toContain("已变化");
  expect(
    result.files.every((file: any) => file.status === "not_attempted"),
  ).toBe(true);
  expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("rules");
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
  await runner.execute("write_file", {
    path: "a.txt",
    content: "  const timeout = 1000;\n  const retry = 1000;\n",
  });
  await runner.execute("edit_file", {
    path: "a.txt",
    edits: [
      { oldText: "1000", newText: "2000", startLine: 1, endLine: 1 },
      { oldText: "retry", newText: "attempts", startLine: 2, endLine: 2 },
    ],
  });
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "  const timeout = 2000;\n  const attempts = 1000;\n",
  );
});

it("accepts exact snippets with or without the final line ending", async () => {
  const { runner, root } = await fileFixture();
  for (const newline of ["\n", "\r\n"]) {
    const name = newline.length === 1 ? "lf.txt" : "crlf.txt";
    await runner.execute("write_file", {
      path: name,
      content: `prefix first${newline}second suffix${newline}tail`,
    });
    await runner.execute("edit_file", {
      path: name,
      edits: [
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
      ],
    });
    expect(await readFile(path.join(root, name), "utf8")).toBe(
      `prefix joined${newline}tail`,
    );
  }
});

it("rejects missing, ambiguous, out-of-range and overlapping matches without fallback", async () => {
  const { runner, root } = await fileFixture();
  const original = "outside\naaa value value\nlast";
  await runner.execute("write_file", { path: "a.txt", content: original });
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
    await expect(
      runner.execute("edit_file", { path: "a.txt", edits }),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(original);
  }
});

it("applies scoped snippets across files and keeps exact newline matching", async () => {
  const { runner, root } = await fileFixture();
  for (const name of ["a.txt", "b.txt"]) {
    await runner.execute("write_file", {
      path: name,
      content: "prefix one\r\ntwo suffix",
    });
  }

  const rejected = await runner.execute("edit_files", {
    files: [
      {
        path: "a.txt",
        edits: [
          { oldText: "prefix", newText: "new", startLine: 1, endLine: 1 },
        ],
      },
      {
        path: "b.txt",
        edits: [
          { oldText: "one\ntwo", newText: "joined", startLine: 1, endLine: 2 },
        ],
      },
    ],
  });
  expect(rejected.error).toBeTruthy();
  expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
    "prefix one\r\ntwo suffix",
  );
  const result = await runner.execute("edit_files", {
    files: ["a.txt", "b.txt"].map((name) => ({
      path: name,
      edits: [
        { oldText: "one\r\ntwo", newText: "joined", startLine: 1, endLine: 2 },
      ],
    })),
  });
  expect(result.files.every((file: any) => file.status === "written")).toBe(
    true,
  );
  for (const name of ["a.txt", "b.txt"]) {
    expect(await readFile(path.join(root, name), "utf8")).toBe(
      "prefix joined suffix",
    );
  }
});
