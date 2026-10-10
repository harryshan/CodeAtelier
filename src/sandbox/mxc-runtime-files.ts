/**
 * 准备 MXC Runtime 的只读代码快照、私有可写目录与 Broker 持久启动标记。
 * 1. 固定四个 bundle 文件及 SHA-256 manifest，拒绝任意 manifest 路径、符号链接与损坏产物。
 * 2. prepareMxcFiles 在系统临时目录建立独立实例；代码不放在获准工作区或 HOME 下。
 * 3. 启动标记只在 Broker 数据目录中保存，进程确认退出后 cleanup 才删除；崩溃残留由 Runtime fail-closed 处理。
 * 不按旧 PID 杀进程，不自动删除未知实例，不把摘要当成第三方代码签名。构建目录属于可信应用安装。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MXC_RUNTIME_FILES = [
  "agent-runtime.mjs",
  "compaction-worker.mjs",
  "read-file-worker.mjs",
  "subagent-worker.mjs",
] as const;

export function defaultMxcBundleDirectory() {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../../dist/runtime/posix/"
        : "../../runtime/posix/",
      import.meta.url,
    ),
  );
}

export async function readMxcBundle(directory: string) {
  const manifestFile = path.join(directory, "runtime.manifest.json");
  const info = await lstat(manifestFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) {
    throw new Error("MXC Runtime manifest 无效。");
  }

  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.version !== 1 || manifest.nodeMajor !== 24 || !manifest.files) {
    throw new Error("MXC Runtime bundle 版本不兼容。");
  }

  const files = new Map<string, Buffer>();
  for (const name of MXC_RUNTIME_FILES) {
    const file = path.join(directory, name);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("MXC Runtime bundle 必须是普通文件。");
    }

    const content = await readFile(file);
    if (
      createHash("sha256").update(content).digest("hex") !==
      manifest.files[name]
    ) {
      throw new Error("MXC Runtime bundle 摘要不匹配；请重新构建。");
    }

    files.set(name, content);
  }

  return files;
}

export async function prepareMxcFiles(
  bundle: Map<string, Buffer>,
  journalDirectory: string,
) {
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codeatelier-mxc-")),
  );
  const code = path.join(root, "code");
  const home = path.join(root, "home");
  const temporary = path.join(root, "tmp");
  const journal = path.join(journalDirectory, `${randomUUID()}.json`);
  try {
    for (const directory of [code, home, temporary]) {
      await mkdir(directory, { mode: 0o700 });
    }

    for (const [name, contents] of bundle) {
      await writeFile(path.join(code, name), contents, {
        flag: "wx",
        mode: 0o400,
      });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    code,
    home,
    temporary,
    async markLaunching(identity: {
      taskId: string;
      executionInstanceId: string;
    }) {
      await writeFile(
        journal,
        JSON.stringify({
          version: 1,
          ...identity,
          root,
          state: "launching",
          createdAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600, flush: true },
      );
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      await rm(journal, { force: true });
    },
  };
}
