/**
 * Linux 内部依赖符号链接的只读版本，供 POSIX 清单桥接和 Publisher 复核使用。
 * 1. checkSymlinkTarget 校验相对目标，只允许前导回退且不能超出来源根；
 *    不先规范化再检查，避免 a/../b 中 a 为链接时改变实际解析语义。
 * 2. symlinkVersion 绑定原始 inode/stamp 与链接文本，目标文件由独立读依赖负责。
 * 3. readSymlinkVersion 校验真实父目录、读取链接自身并复核前后身份；不打开目标。
 * 不扩大 checkedPath 或源码写入能力；不支持 Windows junction、绝对/外部链接。
 * 调用方负责生命周期和 tracing，外部进程仍有检查后竞争窗口。
 */
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import {
  checkedPath,
  checkRelative,
  digest,
  sourceIdentity,
  type Source,
} from "./files.js";
import { PublishError } from "./merge.js";
import type { BigIntStats } from "node:fs";

export function checkSymlinkTarget(relative: string, target: string) {
  const parent = checkRelative(relative).slice(0, -1);
  if (!target || Buffer.byteLength(target) > 4096 || target.startsWith("/")) {
    throw new PublishError("SYMLINK_TARGET_REJECTED");
  }

  let descended = false;
  for (const part of target.split("/")) {
    if (part === ".") {
      continue;
    }

    if (part === "..") {
      if (descended || parent.length === 0) {
        throw new PublishError("SYMLINK_TARGET_REJECTED");
      }

      parent.pop();
    } else {
      checkRelative(part);
      parent.push(part);
      descended = true;
    }
  }
}

export function symlinkVersion(stamp: string, target: string) {
  return `symlink-v1:${digest(`${stamp}:${JSON.stringify(target)}`)}`;
}

function stamp(info: BigIntStats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`;
}

export async function readSymlinkVersion(source: Source, relative: string) {
  if (process.platform !== "linux") {
    throw new PublishError("SYMLINK_PLATFORM_UNSUPPORTED");
  }

  const parts = checkRelative(relative);
  const checkedParent = async () => {
    const current = await sourceIdentity(source.root);
    if (current.root !== source.root || current.identity !== source.identity) {
      throw new PublishError("SOURCE_REPLACED");
    }

    const parent = parts.slice(0, -1).join("/");

    return parent ? checkedPath(source, parent) : source.root;
  };

  const file = path.join(await checkedParent(), parts.at(-1)!);
  const before = await lstat(file, { bigint: true });
  if (!before.isSymbolicLink() || before.size > 4096n) {
    throw new PublishError("SYMLINK_TYPE_OR_LIMIT");
  }

  const target = new TextDecoder("utf-8", { fatal: true }).decode(
    await readlink(file, { encoding: "buffer" }),
  );
  checkSymlinkTarget(relative, target);
  await checkedParent();
  if (stamp(await lstat(file, { bigint: true })) !== stamp(before)) {
    throw new PublishError("READ_CHANGED");
  }

  return symlinkVersion(stamp(before), target);
}
