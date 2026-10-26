/**
 * Linux 正常收尾时，确认本批已发布普通文件造成的目录成员变化，供 acknowledgePosixRound 调用。
 * 1. refreshPosixDirectoryReads 从 complete 日志筛出新增/删除，按直接父目录分组，不处理目录写入。
 * 2. 对已有目录读凭据取得有界稳定成员；逆转本批成员变化后的身份/摘要必须匹配旧版本。
 * 3. 只返回证明成立的新目录凭据；不修改文件或状态，调用方还须复核全部依赖并卸载/释放。
 * 同一目录的历史不同版本均须通过，不静默接受外部变化。只枚举有关父目录，不遍历来源树。
 * 入口使用已校验并与批次绑定的日志；跟随原 Linux finish tracing，不另记录路径或成员名称。
 */
import path from "node:path";
import { checkRelative } from "./publication/files.js";
import type { Entry, Journal } from "./publication/journal.js";
import { PublishError } from "./publication/merge.js";
import {
  directorySnapshotVersion,
  readDirectorySnapshot,
} from "./publication/read-version.js";
import type { Batch } from "./publication/session.js";

export async function refreshPosixDirectoryReads(
  journal: Journal,
  reads: Batch["reads"],
): Promise<Batch["reads"]> {
  if (journal.state !== "complete") {
    throw new PublishError("PUBLICATION_NOT_COMPLETE");
  }

  const changes = new Map<string, Entry[]>();
  for (const entry of journal.entries) {
    checkRelative(entry.path);
    if ((entry.before.content === null) !== (entry.after === null)) {
      const parent = path.posix.dirname(entry.path);
      const group = changes.get(parent) ?? [];
      group.push(entry);
      changes.set(parent, group);
    }
  }

  const versions = new Map<string, { before: string; after: string }>();
  const refreshed: Batch["reads"] = [];
  for (const read of reads) {
    const entries = changes.get(read.path);
    if (read.kind !== "directory" || !entries) {
      refreshed.push(read);
      continue;
    }

    let proof = versions.get(read.path);
    if (!proof) {
      const current = await readDirectorySnapshot(
        journal.batch.source,
        read.path,
      );
      if (!current) {
        throw new PublishError("STALE_DEPENDENCY");
      }

      const previous = new Set(current.members);
      for (const entry of entries) {
        const name = path.posix.basename(entry.path);
        const member = `${name}\0f`;
        if (entry.before.content === null) {
          if (!previous.delete(member)) {
            throw new PublishError("STALE_DEPENDENCY");
          }
        } else {
          if (
            ["f", "d", "l", "o"].some((kind) =>
              previous.has(`${name}\0${kind}`),
            )
          ) {
            throw new PublishError("STALE_DEPENDENCY");
          }

          previous.add(member);
        }
      }

      proof = {
        before: directorySnapshotVersion(current.identity, [...previous]),
        after: current.version,
      };
      // 不保留大目录成员数组；一组变化只需要两个有界摘要供历史凭据逐项核对。
      versions.set(read.path, proof);
    }

    if (read.version !== proof.before) {
      throw new PublishError("STALE_DEPENDENCY");
    }

    refreshed.push({ ...read, version: proof.after });
  }

  return refreshed;
}
