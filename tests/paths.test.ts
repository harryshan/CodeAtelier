/**
 * 用真实临时目录检查路径解析、越界判断和敏感文件识别。
 * 直接调用路径函数，不经过模型或工具审批。
 *
 * 1. 区分工作区子目录和名称前缀相同的兄弟目录。
 * 2. 检查尚未创建的嵌套路径和包含上级跳转的路径，核对真实目标及越界标记。
 * 3. 区分凭据文件与只是名称包含 credential 等字样的普通源码。
 * 4. 确认工作区必须是已有目录；Windows 用例检查 NTFS 备用数据流路径被拒绝。
 */

import { it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  inside,
  pathRisk,
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

it("classifies dotenv templates separately while preserving conservative file sensitivity", () => {
  expect(pathRisk(".env")).toBe("dotenv-runtime");
  expect(pathRisk(".env.local")).toBe("dotenv-runtime");
  expect(pathRisk(".env.example")).toBe("dotenv-template");
  expect(pathRisk("config.env.sample")).toBe("dotenv-template");
  expect(pathRisk(".env.example.bak")).toBe("dotenv-runtime");
  expect(pathRisk("cert.pem")).toBe("hard-sensitive");
  expect(pathRisk("src/config.ts")).toBe("ordinary");
  expect(sensitive(".env.example")).toBe(true);
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
