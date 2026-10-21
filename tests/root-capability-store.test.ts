/**
 * 验证 Broker 的持久根 SID 仓库；使用临时数据目录和真实 AccessManifest，不访问产品安装。
 * 1. 相同对象重新加载复用 SID，不同根独立；只读和私有临时根不取得持久身份。
 * 2. 文件记录损坏或身份不符时拒绝，不覆盖损坏证据；数据目录不可被授权根覆盖。
 * 3. 两个真实 Node 进程并发发布后重启读取，复用同一磁盘身份；链接目录拒绝。
 * 4. 目录对象替换获得不同身份，取消不写入，SID 校验拒绝系统主体及越界子权限。
 * Windows 使用真实宿主私有文件 ACL；POSIX 验证 0600，不等同安装态 token/ACL 验收。
 */
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  symlink,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAccessManifest } from "../src/sandbox/access-manifest.js";
import {
  resolveRootCapabilities,
  validRootCapabilitySid,
} from "../src/sandbox/root-capability-store.js";
import { temp } from "./fixtures/helpers.js";

async function fixture() {
  const directory = await temp();
  const workspace = path.join(directory, "workspace");
  const extra = path.join(directory, "extra");
  const privateDirectory = path.join(directory, "private");
  const readOnly = path.join(directory, "read-only");
  await Promise.all(
    [workspace, extra, privateDirectory, readOnly].map((entry) => mkdir(entry)),
  );
  const manifest = await buildAccessManifest({
    workspaceRoot: workspace,
    readWriteRoots: [extra, privateDirectory],
    readOnlyRoots: [readOnly],
  });

  return {
    directory,
    workspace,
    data: path.join(directory, "data"),
    access: {
      manifest,
      privateDirectory,
      leaseEpoch: 1,
      installObjectIdentityDigests: [],
    },
    signal: new AbortController().signal,
  };
}

describe("persistent root capabilities", () => {
  it("reuses published identities after reload and excludes private/read-only roots", async () => {
    const f = await fixture();
    const first = resolveRootCapabilities(f.data, f.access, f.signal);
    const second = resolveRootCapabilities(
      f.data,
      structuredClone(f.access),
      f.signal,
    );

    expect(second).toEqual(first);
    expect(first.size).toBe(2);
    expect(new Set(first.values()).size).toBe(2);
    expect([...first.values()].every(validRootCapabilitySid)).toBe(true);
    expect(
      await readdir(path.join(f.data, "sandbox-root-capabilities")),
    ).toHaveLength(2);
  });

  it("publishes one identity across concurrent processes and reuses it after restart", async () => {
    const f = await fixture();
    const manifest = await buildAccessManifest({ workspaceRoot: f.workspace });
    const input = { data: f.data, access: { ...f.access, manifest } };
    const moduleUrl = pathToFileURL(
      path.resolve("src/sandbox/root-capability-store.ts"),
    ).href;
    const code = `import { resolveRootCapabilities } from ${JSON.stringify(moduleUrl)};
      const input = JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify([...resolveRootCapabilities(input.data, input.access, new AbortController().signal)]));`;
    const run = async () => {
      const output = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          code,
          JSON.stringify(input),
        ],
        { windowsHide: true, timeout: 30_000 },
      );

      return JSON.parse(output.stdout);
    };

    const [first, concurrent] = await Promise.all([run(), run()]);
    expect(concurrent).toEqual(first);
    expect(await run()).toEqual(first);
    expect(
      await readdir(path.join(f.data, "sandbox-root-capabilities")),
    ).toHaveLength(1);
  });

  it("rejects a redirected registry directory before publishing", async () => {
    const f = await fixture();
    const target = path.join(f.directory, "redirect");
    await mkdir(f.data);
    await mkdir(target);
    await symlink(
      target,
      path.join(f.data, "sandbox-root-capabilities"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => resolveRootCapabilities(f.data, f.access, f.signal)).toThrow(
      "链接",
    );
    expect(await readdir(target)).toEqual([]);
  });

  it("preserves a corrupt record instead of rotating the SID", async () => {
    const f = await fixture();
    const first = resolveRootCapabilities(f.data, f.access, f.signal);
    const file = path.join(
      f.data,
      "sandbox-root-capabilities",
      `${[...first.keys()][0]}.json`,
    );
    await writeFile(file, "broken");

    expect(() => resolveRootCapabilities(f.data, f.access, f.signal)).toThrow();
    expect(await readFile(file, "utf8")).toBe("broken");
  });

  it("rejects a record copied from a different root", async () => {
    const f = await fixture();
    const first = resolveRootCapabilities(f.data, f.access, f.signal);
    const files = [...first.keys()].map((digest) =>
      path.join(f.data, "sandbox-root-capabilities", `${digest}.json`),
    );
    await writeFile(files[0]!, await readFile(files[1]!, "utf8"));

    expect(() => resolveRootCapabilities(f.data, f.access, f.signal)).toThrow(
      "身份不匹配",
    );
  });

  it("binds identity to the actual object rather than only its path", async () => {
    const f = await fixture();
    const first = resolveRootCapabilities(f.data, f.access, f.signal);
    await rename(f.workspace, `${f.workspace}-old`);
    await mkdir(f.workspace);
    const manifest = await buildAccessManifest({ workspaceRoot: f.workspace });
    const second = resolveRootCapabilities(
      f.data,
      { ...f.access, manifest },
      f.signal,
    );

    expect(first.has([...second.keys()][0]!)).toBe(false);
    expect([...first.values()]).not.toContain([...second.values()][0]);
  });

  it("rejects data-root overlap and cancellation before publication", async () => {
    const f = await fixture();
    expect(() =>
      resolveRootCapabilities(
        path.join(f.workspace, "data"),
        f.access,
        f.signal,
      ),
    ).toThrow("数据目录");
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      resolveRootCapabilities(f.data, f.access, controller.signal),
    ).toThrow();
    await expect(readdir(f.data)).rejects.toThrow();
  });

  it.each([
    "S-1-1-0",
    "S-1-5-18",
    "S-1-5-21-0-1-2-3",
    "S-1-5-21-1-2-3-4294967296",
    "S-1-5-21-01-2-3-4",
  ])("rejects invalid capability %s", (sid) => {
    expect(validRootCapabilitySid(sid)).toBe(false);
  });
});
