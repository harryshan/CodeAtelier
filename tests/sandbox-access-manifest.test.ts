/**
 * 验证 Windows Sandbox AccessManifest 在任何原生副作用前固定授权根、模式与对象身份。
 * 用例使用临时目录和文件，不修改真实 ACL，也不依赖 Windows 管理员权限。
 *
 * 1. 工作区自动成为可写根，并与显式根、Git 配置生成稳定摘要。
 * 2. 同一对象按身份去重，读写模式冲突安全拒绝。
 * 3. 缺失对象、错误对象类型和符号链接入口在 provision 前拒绝。
 */

import { expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAccessManifest } from "../src/sandbox/access-manifest.js";
import { temp } from "./fixtures/helpers.js";

it("builds a stable manifest for workspace, explicit roots and Git config", async () => {
  const root = await temp();
  const readable = path.join(root, "tooling");
  const extraWrite = path.join(root, "generated");
  const gitConfig = path.join(root, "host.gitconfig");
  await mkdir(readable);
  await mkdir(extraWrite);
  await writeFile(gitConfig, "[user]\n\tname = Example\n");

  const first = await buildAccessManifest({
    workspaceRoot: root,
    readOnlyRoots: [readable, readable],
    readWriteRoots: [extraWrite],
    gitConfigFiles: [gitConfig],
  });
  const second = await buildAccessManifest({
    workspaceRoot: root,
    readOnlyRoots: [readable],
    readWriteRoots: [extraWrite],
    gitConfigFiles: [gitConfig],
  });

  expect(first).toEqual(second);
  expect(first.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(first.workspaceRootId).toBe(first.writeRoots[0]?.rootId);
  expect(first.readRoots).toHaveLength(1);
  expect(first.writeRoots).toHaveLength(2);
  expect(first.gitConfigFiles).toHaveLength(1);
});

it("rejects objects declared as both readable and writable", async () => {
  const root = await temp();
  const shared = path.join(root, "shared");
  await mkdir(shared);

  await expect(
    buildAccessManifest({
      workspaceRoot: root,
      readOnlyRoots: [shared],
      readWriteRoots: [shared],
    }),
  ).rejects.toMatchObject({ code: "SANDBOX_ACCESS_MANIFEST" });
});

it("rejects missing, wrong-type and linked roots before provisioning", async () => {
  const root = await temp();
  const file = path.join(root, "not-a-directory");
  const target = path.join(root, "target");
  const linked = path.join(root, "linked");
  await writeFile(file, "value");
  await mkdir(target);
  await symlink(
    target,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );

  await expect(
    buildAccessManifest({ workspaceRoot: file }),
  ).rejects.toMatchObject({ code: "SANDBOX_ACCESS_MANIFEST" });
  await expect(
    buildAccessManifest({
      workspaceRoot: root,
      readOnlyRoots: [path.join(root, "missing")],
    }),
  ).rejects.toMatchObject({ code: "SANDBOX_ACCESS_MANIFEST" });
  await expect(
    buildAccessManifest({ workspaceRoot: linked }),
  ).rejects.toMatchObject({ code: "SANDBOX_ACCESS_MANIFEST" });
});
