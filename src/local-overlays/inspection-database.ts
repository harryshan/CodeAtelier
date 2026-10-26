/**
 * 中断检查的私有 SQLite 元数据副本，供 interrupted-review 在原生排他租约内调用。
 * 1. 只复制已知 main/WAL 两个文件到全新检查目录，不复制源码、对象、SHM 或全树。
 * 2. 逐文件限制 256 MiB，使用 64 KiB 缓冲及打开前后身份/大小/时间复核；拒绝链接和别名硬链接。
 * 3. SQLite 只打开副本，可在副本创建读锁/空 WAL，原文件不被 SQLite 连接触碰。
 * 4. 回调结束只清理本目录内四个固定数据库文件，再移除空目录；失败不递归删除未知内容。
 * 调用方负责控制目录及旧进程证明、取消和 tracing；本模块不推导副本等于完成的文件写入。
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import { PublishError } from "./publication/merge.js";
import { inside } from "../tools/paths.js";

function stamp(info: BigIntStats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.nlink}`;
}

async function copyMetadata(
  source: string,
  target: string,
  optional: boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let before: BigIntStats;
  try {
    before = await lstat(source, { bigint: true });
  } catch (error: any) {
    if (optional && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 256n * 1024n * 1024n
  ) {
    throw new PublishError("NATIVE_DATABASE_INVALID");
  }

  const input = await open(source, "r");
  try {
    if (stamp(await input.stat({ bigint: true })) !== stamp(before)) {
      throw new PublishError("READ_CHANGED");
    }

    const output = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let copied = 0;
      while (copied <= Number(before.size)) {
        signal.throwIfAborted();
        const { bytesRead } = await input.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) + 1 - copied),
          copied,
        );
        if (!bytesRead) {
          break;
        }

        await output.writeFile(buffer.subarray(0, bytesRead));
        copied += bytesRead;
      }

      if (
        copied !== Number(before.size) ||
        stamp(await input.stat({ bigint: true })) !== stamp(before) ||
        stamp(await lstat(source, { bigint: true })) !== stamp(before)
      ) {
        throw new PublishError("READ_CHANGED");
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

export async function withInspectionDatabase<T>(
  original: string,
  temporaryRoot: string,
  signal: AbortSignal,
  forbiddenRoots: readonly string[],
  operation: (database: string) => Promise<T>,
): Promise<T> {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const actual = await realpath(temporaryRoot);
  if (forbiddenRoots.some((root) => inside(root, actual))) {
    throw new PublishError("INSPECTION_DIRECTORY_INVALID");
  }

  const directory = await mkdtemp(path.join(actual, "inspection-"));
  const database = path.join(directory, "overlay.sqlite");
  try {
    await copyMetadata(original, database, false, signal);
    await copyMetadata(original + "-wal", database + "-wal", true, signal);
    signal.throwIfAborted();

    return await operation(database);
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      await rm(database + suffix, { force: true });
    }

    await rmdir(directory);
  }
}
