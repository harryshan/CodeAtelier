/**
 * 发布 PoC 的受控普通文件 I/O，供会话基线、Publisher 与恢复观察使用。
 * 1. sourceIdentity 固定目录的真实路径和 inode；checkedPath 拒绝越界、链接和管理目录。
 * 2. snapshot 有界读取并核对路径/句柄前后身份；版本含内容和元数据，不依赖 mtime 单项。
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
      part.toLowerCase().startsWith(".codeatelier-publish-")
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
    before.nlink !== 1n ||
    before.size > BigInt(MAX_BYTES)
  ) {
    throw new PublishError("FILE_TYPE_OR_LIMIT");
  }

  const handle = await open(target, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (stamp(before) !== stamp(opened)) {
      throw new PublishError("READ_CHANGED");
    }

    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!result.bytesRead) {
        break;
      }

      length += result.bytesRead;
    }

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

    const content = buffer.subarray(0, length);

    return {
      content: content.toString("base64"),
      version: digest(stamp(before) + ":" + digest(content)),
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
