/**
 * Linux 内部依赖链接的契约与真实文件版本测试。
 * 1. 纯路径用例覆盖 pnpm 相对目标、前导回退、越界及中途回退拒绝，所有平台运行。
 * 2. Linux 文件夹具核对链接自身和目标独立版本、改向拒绝，以及 Publisher 发布普通源码。
 *    不在 Windows 创建 junction 或要求符号链接权限；真实 OverlayFS/Sandbox 由手动探针覆盖。
 * 3. 每例使用独占临时目录，结束只删除本例内容，不操作用户项目或挂载。
 */
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  unlink,
  rm,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkSymlinkTarget } from "../src/local-overlays/publication/symlink-read.js";
import { readVersion } from "../src/local-overlays/publication/read-version.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";

it.each([
  ["node_modules/pkg", ".pnpm/pkg/node_modules/pkg"],
  ["node_modules/.bin/tsc", "../typescript/bin/tsc"],
  ["node_modules/.pnpm/a/node_modules/b", "../../b/node_modules/b"],
  ["src/link", "../shared"],
])("accepts internal relative target %s -> %s", (file, target) => {
  expect(() => checkSymlinkTarget(file, target)).not.toThrow();
});

it.each([
  "/tmp/outside",
  "../../outside",
  "a/../../outside",
  "a/../b",
  "../.git/config",
  "a//b",
  "a/",
  "",
])("rejects unsafe target %s", (target) => {
  expect(() => checkSymlinkTarget("src/link", target)).toThrow();
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")(
  "validates links independently and rejects retargeting before publication",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "overlay-links-"));
    roots.push(root);
    const directory = path.join(root, "source");
    await mkdir(directory);
    await writeFile(path.join(directory, "dep"), "one");
    await writeFile(path.join(directory, "other"), "two");
    await writeFile(path.join(directory, "code"), "original\n");
    await symlink("dep", path.join(directory, "alias"));
    const source = await sourceIdentity(directory);
    const read = { path: "alias", kind: "symlink" as const };
    const version = await readVersion(source, read);
    const targetVersion = await readVersion(source, { path: "dep" });
    await writeFile(path.join(directory, "dep"), "changed");
    expect(await readVersion(source, read)).toBe(version);
    expect(await readVersion(source, { path: "dep" })).not.toBe(targetVersion);

    const session = new EditSession(source);
    await session.read("code");
    await session.edit("code", Buffer.from("private\n"));
    const batch = session.seal();
    batch.reads.push({ ...read, version });
    await new Publisher(path.join(root, "publications")).publish(batch, {
      validate: async () => {},
    });
    expect(await readFile(path.join(directory, "code"), "utf8")).toBe(
      "private\n",
    );

    const next = new EditSession(source);
    await next.read("code");
    await next.edit("code", Buffer.from("later\n"));
    const pending = next.seal();
    pending.reads.push({ ...read, version });
    await unlink(path.join(directory, "alias"));
    await symlink("other", path.join(directory, "alias"));
    expect(await readVersion(source, read)).not.toBe(version);
    await expect(
      new Publisher(path.join(root, "publications")).publish(pending, {
        validate: async () => {},
      }),
    ).rejects.toThrow("STALE_DEPENDENCY");
    expect(await readFile(path.join(directory, "code"), "utf8")).toBe(
      "private\n",
    );
  },
);
