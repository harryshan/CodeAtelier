/**
 * Linux 正常跨轮状态的有界读取，供 backend 续轮和离线文件检查复用。
 * 1. readPosixRound 拒绝链接/非普通文件和过大状态，核对句柄及读取期间的版本。
 * 2. validatePosixRound 负责来源、基线及读集预算；本模块不挂载、不修改状态或发布。
 * 调用方持有 Service 视图锁，并单独拒绝 pending/未知生命周期。
 */
import { lstat, open } from "node:fs/promises";
import type { Source } from "./publication/files.js";
import { PublishError } from "./publication/merge.js";
import { validatePosixRound } from "./posix-round.js";

export async function readPosixRound(file: string, source: Source) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 32 * 1024 * 1024
  ) {
    throw new PublishError("ROUND_STATE_INVALID");
  }

  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size !== info.size
    ) {
      throw new PublishError("ROUND_STATE_CHANGED");
    }

    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const linked = await lstat(file);
    if (
      bytesRead !== info.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino ||
      linked.size !== opened.size ||
      linked.mtimeMs !== opened.mtimeMs ||
      linked.ctimeMs !== opened.ctimeMs
    ) {
      throw new PublishError("ROUND_STATE_CHANGED");
    }

    return validatePosixRound(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
      source,
    );
  } finally {
    await handle.close();
  }
}
