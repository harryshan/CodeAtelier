/**
 * 文件作用：验证工作区路径规范化和敏感文件识别。
 * 代码结构：用例依次覆盖同前缀目录、新建路径与父级越界、敏感名称以及工作区必须是真实目录。
 */

import { it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  inside,
  resolveTarget,
  sensitive,
  workspacePath,
} from "../src/tools/paths.js";
import { temp } from "./fixtures/helpers.js";

it("distinguishes children from sibling paths sharing the workspace prefix", async () => {
  const root = await temp();

  expect(inside(root, root)).toBe(true);
  expect(inside(root, path.join(root, "src/a.ts"))).toBe(true);
  expect(inside(root, root + "-other")).toBe(false);
  expect(inside(root, path.dirname(root))).toBe(false);
});

it("resolves new nested paths and flags parent traversal", async () => {
  const root = await temp();

  expect(await resolveTarget(root, "src/new/a.ts")).toMatchObject({
    path: path.join(root, "src/new/a.ts"),
    outside: false,
  });
  expect((await resolveTarget(root, "../outside.txt")).outside).toBe(true);
  await expect(resolveTarget(root, "a\0b")).rejects.toThrow("非法字符");
});

it("identifies sensitive path components without classifying ordinary names as secrets", () => {
  for (const file of [
    ".env.local",
    ".ssh/config",
    ".aws/credentials",
    "private.KEY",
    "cert.pem",
    "nested/.npmrc",
  ]) {
    expect(sensitive(file)).toBe(true);
  }

  for (const file of ["environment.ts", "keybindings.json", "src/config.ts"]) {
    expect(sensitive(file)).toBe(false);
  }
});

it("requires a real directory as workspace", async () => {
  const root = await temp();

  await writeFile(path.join(root, "file"), "x");
  await mkdir(path.join(root, "src"));

  expect(await workspacePath(path.join(root, "src/.."))).toBe(root);
  await expect(workspacePath(path.join(root, "file"))).rejects.toThrow("目录");
  await expect(workspacePath(path.join(root, "missing"))).rejects.toThrow();
});

it.skipIf(process.platform !== "win32")(
  "rejects NTFS alternate data streams",
  async () => {
    await expect(
      resolveTarget(await temp(), "file.txt:secret"),
    ).rejects.toThrow("备用数据流");
  },
);
