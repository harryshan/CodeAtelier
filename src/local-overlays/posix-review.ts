/**
 * 正常卸载的 Linux 私有文件检查，供 backend 在 Service 视图锁内调用。
 * 1. 读取有界 round 基线，拒绝 pending；控制器 classify 证明 mount ready 并区分普通文件/whiteout。
 * 2. 仅对明确选集读取 B/O/T 和生成合并预览，共用 100 文件/2 MiB 单文件/16 MiB 内容预算。
 * 3. 末尾复核 upper 分类、来源版本和 round，材料摘要供新参考会话绑定，不是发布许可。
 * 不挂载、不扫描来源、不改变私有层或来源，不接受异常卷、链接或复杂目录覆盖。
 * 调用方提供取消和 tracing；外部写入仍存在最终检查后的竞争窗口。
 */
import { lstat } from "node:fs/promises";
import type { LinuxPrivateClassification } from "./linux-controller.js";
import { readPosixRound } from "./posix-state.js";
import {
  bytes,
  checkedPath,
  digest,
  snapshot,
  sourceIdentity,
  type Source,
  type Snapshot,
} from "./publication/files.js";
import { mergeContent, PublishError } from "./publication/merge.js";
import {
  reviewSelection,
  type LocalFileReview,
  type LocalReviewBatch,
} from "./publication/review.js";

export async function reviewPosixFiles(
  source: Source,
  controlDirectory: string,
  requested: readonly string[],
  classify: (paths: readonly string[]) => Promise<LinuxPrivateClassification>,
  signal: AbortSignal,
): Promise<LocalReviewBatch> {
  const selected = reviewSelection(requested);
  if (new Set(selected).size !== selected.length) {
    throw new PublishError("DUPLICATE_PATH");
  }

  signal.throwIfAborted();
  const control = await sourceIdentity(controlDirectory);
  const requireReady = async () => {
    const file = await checkedPath(control, "round.pending.json");
    await lstat(file).then(
      () => {
        throw new PublishError("ROUND_PENDING");
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      },
    );
  };

  await requireReady();
  const roundFile = await checkedPath(control, "round.json");
  const state = await readPosixRound(roundFile, source);
  const originals = new Map(
    state.baselines.map((entry) => [entry.path, entry.base]),
  );
  for (const name of selected) {
    if (!originals.has(name)) {
      throw new PublishError("POSIX_BASELINE_MISSING");
    }
  }

  const upper = await sourceIdentity(await checkedPath(control, "upper"));
  const before = await classify(selected);
  if (
    before.source !== source.root ||
    before.sourceIdentity !== source.identity ||
    before.upperIdentity !== upper.identity ||
    JSON.stringify(before.files.map((entry) => entry.path)) !==
      JSON.stringify(selected)
  ) {
    throw new PublishError("REVIEW_IDENTITY_CHANGED");
  }

  const files: LocalFileReview[] = [];
  let total = 0;
  for (const entry of before.files) {
    signal.throwIfAborted();
    const base = originals.get(entry.path)!;
    const ours: Snapshot = entry.deleted
      ? {
          content: null,
          version: `whiteout-v1:${digest(entry.stamp)}`,
          mode: null,
        }
      : await snapshot(upper, entry.path);
    if (
      !entry.deleted &&
      (ours.content === null ||
        ours.version !== digest(`${entry.stamp}:${digest(bytes(ours)!)}`))
    ) {
      throw new PublishError("READ_CHANGED");
    }

    const current = await snapshot(source, entry.path);
    let preview: LocalFileReview["preview"];
    try {
      const merged = mergeContent(bytes(base), bytes(ours), bytes(current));
      preview = {
        state: "merged",
        content: merged?.toString("base64") ?? null,
      };
    } catch (error) {
      if (!(error instanceof PublishError)) {
        throw error;
      }

      preview = { state: "conflict", reason: error.code };
    }

    total += [
      base.content,
      ours.content,
      current.content,
      preview.state === "merged" ? preview.content : null,
    ].reduce<number>(
      (sum, content) =>
        sum + (content === null ? 0 : Buffer.byteLength(content, "base64")),
      0,
    );
    if (total > 16 * 1024 * 1024) {
      throw new PublishError("REVIEW_CONTENT_LIMIT");
    }

    files.push({
      path: entry.path,
      epoch: state.epoch,
      version: digest(
        JSON.stringify({
          source,
          control,
          epoch: state.epoch,
          entry,
          base,
          ours,
          current,
        }),
      ),
      base,
      ours,
      current,
      preview,
      publicationChecked: false,
    });
  }

  signal.throwIfAborted();
  if (
    JSON.stringify(await classify(selected)) !== JSON.stringify(before) ||
    JSON.stringify(await readPosixRound(roundFile, source)) !==
      JSON.stringify(state)
  ) {
    throw new PublishError("READ_CHANGED");
  }

  await requireReady();
  for (const file of files) {
    signal.throwIfAborted();
    if ((await snapshot(source, file.path)).version !== file.current.version) {
      throw new PublishError("READ_CHANGED");
    }
  }

  return {
    version: digest(
      JSON.stringify(
        files.map((file) => ({ path: file.path, version: file.version })),
      ),
    ),
    files,
    publicationChecked: false,
  };
}
