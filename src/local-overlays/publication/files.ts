/**
 * Local 发布的受控普通文件 I/O，供原生批次导出、Publisher、恢复观察和独立测试会话使用。
 * 1. sourceIdentity 固定目录的真实路径和 inode；checkedPath 拒绝越界、链接和管理目录。
 *    发布备份与冲突参考保留前缀也拒绝，防止私有参考材料被当成源码发布。
 * 2. snapshot 有界读取并核对路径/句柄前后身份；版本含内容和元数据，不依赖 mtime 单项。
 *    snapshotVersion 对只读依赖使用固定大小缓冲和流式哈希，不扩大可发布正文上限；同文件版本编码保持一致。
 *    只读依赖允许包管理器硬链接，任何别名写入仍影响版本；可编辑完整快照仍严格要求单链接。
 *    已有父目录下的缺失目标返回 missing，供原生负向观察及发布前再次核对；不把权限拒绝视为缺失。
 * 3. durableJson 以临时文件、flush、rename 保存私有日志；不宣称跨文件/断电原子性。
 * 首版要求父目录已存在、普通文件只有一个硬链接；不支持 ACL 保真或目录 rename。
 * 所有检查仅降低外部写入竞争，不能替代内核级路径/内容 compare-and-swap。
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import { MAX_BYTES, PublishError } from "./merge.js";

export interface Source {
  root: string;
  identity: string;
}

export interface Snapshot {
  content: string | null;
  version: string;
  mode: number | null;
}

export function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function bytes(value: Snapshot) {
  return value.content === null ? null : Buffer.from(value.content, "base64");
}

function identity(info: BigIntStats) {
  return `${info.dev}:${info.ino}`;
}

function stamp(info: BigIntStats) {
  return `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`;
}

export async function sourceIdentity(directory: string): Promise<Source> {
  const root = await realpath(directory);
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PublishError("SOURCE_TYPE");
  }

  return { root, identity: identity(info) };
}

export function checkRelative(relative: string) {
  if (!relative || relative.length > 1024) {
    throw new PublishError("PATH_REJECTED");
  }

  const parts = relative.split("/");
  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[\\:\x00-\x1f<>"|?*]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      /^(?:\.git|\.hg|\.svn)$/i.test(part) ||
      part.toLowerCase().startsWith(".codeatelier-publish-") ||
      part.toLowerCase().startsWith(".codeatelier-recovery-")
    ) {
      throw new PublishError("PATH_REJECTED");
    }
  }

  return parts;
}

export async function checkedPath(source: Source, relative: string) {
  const parts = checkRelative(relative);
  const current = await sourceIdentity(source.root);
  if (current.root !== source.root || current.identity !== source.identity) {
    throw new PublishError("SOURCE_REPLACED");
  }

  let target = source.root;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    try {
      const info = await lstat(target);
      if (
        info.isSymbolicLink() ||
        (index < parts.length - 1 && !info.isDirectory())
      ) {
        throw new PublishError("PATH_REPLACED");
      }
    } catch (error: any) {
      if (error.code !== "ENOENT" || index !== parts.length - 1) {
        throw error;
      }
    }
  }

  return target;
}

export async function snapshot(
  source: Source,
  relative: string,
): Promise<Snapshot> {
  return readSnapshot(source, relative, true);
}

export async function snapshotVersion(
  source: Source,
  relative: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await readSnapshot(source, relative, false, signal)).version;
}

async function readSnapshot(
  source: Source,
  relative: string,
  includeContent: boolean,
  signal?: AbortSignal,
): Promise<Snapshot> {
  signal?.throwIfAborted();
  const target = await checkedPath(source, relative);
  let before: BigIntStats;
  try {
    before = await lstat(target, { bigint: true });
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { content: null, version: "missing", mode: null };
    }

    throw error;
  }

  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (includeContent && before.nlink !== 1n) ||
    before.size > BigInt(includeContent ? MAX_BYTES : 256 * 1024 * 1024)
  ) {
    throw new PublishError("FILE_TYPE_OR_LIMIT");
  }

  const handle = await open(target, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (stamp(before) !== stamp(opened)) {
      throw new PublishError("READ_CHANGED");
    }

    const buffer = Buffer.alloc(
      includeContent ? Number(before.size) + 1 : 64 * 1024,
    );
    const hash = createHash("sha256");
    let length = 0;
    // Read one byte beyond the original size so concurrent growth also rejects.
    while (length <= Number(before.size)) {
      signal?.throwIfAborted();
      const offset = includeContent ? length : 0;
      const result = await handle.read(
        buffer,
        offset,
        Math.min(buffer.length - offset, Number(before.size) + 1 - length),
        length,
      );
      if (!result.bytesRead) {
        break;
      }

      hash.update(buffer.subarray(offset, offset + result.bytesRead));
      length += result.bytesRead;
    }

    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    await checkedPath(source, relative);
    const linked = await lstat(target, { bigint: true });
    if (
      length !== Number(before.size) ||
      stamp(after) !== stamp(before) ||
      stamp(linked) !== stamp(before)
    ) {
      throw new PublishError("READ_CHANGED");
    }

    return {
      content: includeContent
        ? buffer.subarray(0, length).toString("base64")
        : null,
      version: digest(stamp(before) + ":" + hash.digest("hex")),
      mode: Number(before.mode) & 0o777,
    };
  } finally {
    await handle.close();
  }
}

export async function durableJson(file: string, value: unknown) {
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporary, file);
}
