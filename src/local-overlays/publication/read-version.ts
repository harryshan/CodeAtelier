/**
 * 文件与目录读依赖的路径及版本分派，供原生导出、候选收据和 Publisher 使用。
 * 1. checkReadPath 仅对 directory 类型允许根目录点号，写入路径仍由 checkRelative 严格限制。
 * 2. nativeReadPath 将原生观察转换为受控路径/类型；不接受任意本机路径或未识别目录标签。
 * 3. readVersion 对文件沿用流式快照；目录委托 readDirectorySnapshot，只枚举直接名称/类型并绑定身份，排除视图隐藏的 .git。
 *    枚举前后复核身份/时间，持久版本不含时间，避免已清理临时项造成无关失效。
 *    Linux symlink 类型单独复核链接文本和身份，不沿链接打开或赋予源码写入权限。
 * 4. readDirectorySnapshot 返回有界稳定成员和身份，directorySnapshotVersion 统一编码；Linux 正常刷新据此逆验已发布成员变化。
 * 5. 精确 UUID 参考根仅允许 missing 凭据：私有目录创建也会观察 lower 缺失，后续出现则拒绝；子路径和发布仍禁止。
 * 目录每次最多 100,000 项/16 MiB 编码；不递归、不读取成员正文、不声称涵盖条目的大小/时间元数据。
 * 外部写入仍有检查后竞争窗口，按已观测目录验证不等于 OS 原子事务；日志由外层生命周期负责。
 */
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import {
  checkedPath,
  checkRelative,
  digest,
  snapshotVersion,
  sourceIdentity,
  type Source,
} from "./files.js";
import { PublishError } from "./merge.js";
import { readSymlinkVersion } from "./symlink-read.js";

export interface ReadPath {
  path: string;
  kind?: "directory" | "symlink";
}

function referenceRoot(value: string) {
  return /^\.codeatelier-recovery-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    value,
  );
}

export function checkReadPath(read: ReadPath) {
  if (read.kind === "directory" && read.path === ".") {
    return;
  }

  if (!read.kind && referenceRoot(read.path)) {
    return;
  }

  checkRelative(read.path);
}

export function nativeReadPath(name: string, stamp: string): ReadPath {
  if (!name.startsWith("\\")) {
    throw new PublishError("NATIVE_PATH_INVALID");
  }

  const kind = stamp.startsWith("directory-v1:") ? "directory" : undefined;
  const relative = name.slice(1).replaceAll("\\", "/");
  const read: ReadPath = {
    path: kind === "directory" && !relative ? "." : relative,
    ...(kind ? { kind } : {}),
  };
  checkReadPath(read);
  if (referenceRoot(read.path) && stamp !== "missing") {
    throw new PublishError("PATH_REJECTED");
  }

  return read;
}

export async function readVersion(
  source: Source,
  read: ReadPath,
  signal?: AbortSignal,
): Promise<string> {
  checkReadPath(read);
  signal?.throwIfAborted();
  if (referenceRoot(read.path)) {
    const current = await sourceIdentity(source.root);
    if (current.root !== source.root || current.identity !== source.identity) {
      throw new PublishError("SOURCE_REPLACED");
    }

    // Never read these reserved paths as source data or discard their negative
    // dependency. Any object appearing at this exact root invalidates it.
    try {
      await lstat(path.join(source.root, read.path));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }

      throw error;
    }

    throw new PublishError("STALE_DEPENDENCY");
  }

  if (read.kind === "symlink") {
    return readSymlinkVersion(source, read.path);
  }

  if (read.kind !== "directory") {
    return snapshotVersion(source, read.path, signal);
  }

  return (
    (await readDirectorySnapshot(source, read.path, signal))?.version ??
    "missing"
  );
}

export function directorySnapshotVersion(
  identity: string,
  members: readonly string[],
) {
  return `directory-v1:${digest(`${identity}:${JSON.stringify([...members].sort())}`)}`;
}

export async function readDirectorySnapshot(
  source: Source,
  relative: string,
  signal?: AbortSignal,
): Promise<{ identity: string; members: string[]; version: string } | null> {
  checkReadPath({ path: relative, kind: "directory" });

  const checkedDirectory = async () => {
    const current = await sourceIdentity(source.root);
    if (current.root !== source.root || current.identity !== source.identity) {
      throw new PublishError("SOURCE_REPLACED");
    }

    return relative === "." ? source.root : checkedPath(source, relative);
  };

  signal?.throwIfAborted();
  const target = await checkedDirectory();
  let before;
  try {
    before = await lstat(target, { bigint: true });
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new PublishError("DIRECTORY_TYPE");
  }

  const names: string[] = [];
  let size = 0;
  for await (const entry of await opendir(target)) {
    signal?.throwIfAborted();
    if (entry.name.toLowerCase() === ".git") {
      continue;
    }

    const type = entry.isSymbolicLink()
      ? "l"
      : entry.isDirectory()
        ? "d"
        : entry.isFile()
          ? "f"
          : "o";
    const encoded = `${entry.name}\0${type}`;
    size += Buffer.byteLength(encoded, "utf16le");
    if (names.length >= 100_000 || size > 16 * 1024 * 1024) {
      throw new PublishError("DIRECTORY_LIMIT");
    }

    names.push(encoded);
  }

  await checkedDirectory();
  const after = await lstat(target, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.mode !== after.mode ||
    !after.isDirectory() ||
    after.isSymbolicLink()
  ) {
    throw new PublishError("READ_CHANGED");
  }

  const identity = `${before.dev}:${before.ino}`;

  return {
    identity,
    members: names,
    version: directorySnapshotVersion(identity, names),
  };
}
