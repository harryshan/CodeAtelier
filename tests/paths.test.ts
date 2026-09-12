/**
 * 文件作用：验证工作区路径规范化和敏感文件识别。
 *
 * 使用场景与输入输出：
 * 直接调用路径辅助函数，结合临时真实目录验证路径关系及工作区入口校验。
 *
 * 代码结构与阅读顺序：
 * 1. 先区分工作区子目录和名称具有相同前缀的兄弟目录。
 * 2. 对待创建嵌套路径及父级穿越核对解析后的真实目标和越界标志。
 * 3. 敏感名称测试区分真正凭据路径与普通源文件名称。
 * 4. 工作区输入必须指向实际目录，Windows 专用用例检查 NTFS 备用数据流路径被拒绝。
 *
 * 维护注意事项：
 * 不能以字符串 startsWith 代替路径关系，也不能将普通 credential 相关源码一概当作密钥文件。
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
