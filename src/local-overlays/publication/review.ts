/**
 * 已正常卸载的 Local 私有修改检查，供 LocalOverlayService 的排他只读租约调用。
 * 1. 检查 v6 clean 卷、来源身份和封存标识；在一次只读事务内查询最多 100 个明确路径，不扫描文件树。
 * 2. 读取不可变 B、封存 O 与当前 T，各自沿用普通单链接文件和 2 MiB 限制。
 * 3. 生成纯内容合并预览和材料版本摘要；不验证读依赖、运行候选命令或签发发布授权。
 * 4. 始终关闭只读 SQLite 事务；不挂载、清空依赖、刷新视图、解除发布锁或写来源。
 * 5. 整组原始内容/预览最多 16 MiB，末尾复核来源版本；批次摘要绑定整组选定材料，单文件包装保留原接口。
 * 调用方必须持有服务逐视图锁且确认 ready；外层提供取消、生命周期和脱敏 tracing。
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  bytes,
  checkRelative,
  digest,
  snapshot,
  sourceIdentity,
  type Snapshot,
  type Source,
} from "./files.js";
import { mergeContent, PublishError } from "./merge.js";

const rowSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.number().int(),
  object: z.string(),
  stamp: z.string(),
  attributes: z.number().int(),
  flags: z.number().int(),
  resultKind: z.number().int(),
  resultObject: z.string(),
});

export interface LocalFileReview {
  path: string;
  epoch: number;
  version: string;
  base: Snapshot;
  ours: Snapshot;
  current: Snapshot;
  preview:
    | { state: "merged"; content: string | null }
    | { state: "conflict"; reason: string };
  publicationChecked: false;
}

export interface LocalReviewBatch {
  version: string;
  files: LocalFileReview[];
  publicationChecked: false;
}

export function reviewSelection(paths: readonly string[]) {
  if (paths.length < 1 || paths.length > 100) {
    throw new PublishError("REVIEW_FILE_LIMIT");
  }

  let length = 0;
  for (const file of paths) {
    checkRelative(file);
    length += Buffer.byteLength(file);
  }

  if (length > 16 * 1024) {
    throw new PublishError("REVIEW_PATH_LIMIT");
  }

  return [...paths].sort();
}

async function objectSnapshot(
  control: Source,
  directory: "baselines" | "objects",
  kind: number,
  object: string,
): Promise<Snapshot> {
  if (kind === 0) {
    return { content: null, version: "missing", mode: null };
  }

  if (!/^\{[0-9a-f-]{36}\}$/i.test(object)) {
    throw new PublishError("NATIVE_OBJECT_INVALID");
  }

  z.uuid().parse(object.slice(1, -1));
  const value = await snapshot(control, `${directory}/${object}`);
  if (value.content === null) {
    throw new PublishError("NATIVE_OBJECT_MISSING");
  }

  return value;
}

export async function reviewCleanFile(
  source: Source,
  controlDirectory: string,
  selected: string,
  signal: AbortSignal,
): Promise<LocalFileReview> {
  return (await reviewCleanFiles(source, controlDirectory, [selected], signal))
    .files[0]!;
}

export async function reviewCleanFiles(
  source: Source,
  controlDirectory: string,
  requested: readonly string[],
  signal: AbortSignal,
): Promise<LocalReviewBatch> {
  const selection = reviewSelection(requested);
  signal.throwIfAborted();
  const control = await sourceIdentity(controlDirectory);
  const database = path.join(control.root, "overlay.sqlite");
  const info = await lstat(database, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new PublishError("NATIVE_DATABASE_INVALID");
  }

  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("BEGIN");
    const meta = db.prepare("SELECT version,source,clean FROM meta").get();
    if (
      meta?.version !== 6 ||
      meta.clean !== 1 ||
      typeof meta.source !== "string"
    ) {
      throw new PublishError("REVIEW_REQUIRES_CLEAN_VIEW");
    }

    const actual = await sourceIdentity(meta.source);
    if (actual.root !== source.root || actual.identity !== source.identity) {
      throw new PublishError("SOURCE_REPLACED");
    }

    const state = z
      .object({
        epoch: z.number().int().min(0).max(1_000_000_000),
        seal: z.uuid(),
      })
      .parse(db.prepare("SELECT epoch,seal FROM local_state").get());
    const files: LocalFileReview[] = [];
    const keys = new Set<string>();
    const query = db.prepare(
      "SELECT b.*,s.kind AS resultKind,s.object AS resultObject " +
        "FROM baselines b JOIN sealed_changes s ON s.path=b.path " +
        "WHERE b.name COLLATE NOCASE=?",
    );
    let totalBytes = 0;
    for (const selected of selection) {
      signal.throwIfAborted();
      const raw = query.get("\\" + selected.replaceAll("/", "\\"));
      if (!raw) {
        throw new PublishError("NATIVE_CHANGE_MISSING");
      }

      const row = rowSchema.parse(raw);
      if (keys.has(row.path)) {
        throw new PublishError("DUPLICATE_PATH");
      }

      keys.add(row.path);
      if (
        !row.name.startsWith("\\") ||
        row.flags & 4 ||
        ![0, 1].includes(row.kind) ||
        ![0, 1].includes(row.resultKind)
      ) {
        throw new PublishError("NATIVE_CHANGE_UNSUPPORTED");
      }

      const name = row.name.slice(1).replaceAll("\\", "/");
      checkRelative(name);
      const parts = row.path.split("\\");
      for (let count = 2; count < parts.length; count++) {
        if (
          db
            .prepare("SELECT path FROM baselines WHERE path=?")
            .get(parts.slice(0, count).join("\\"))
        ) {
          throw new PublishError("NATIVE_ANCESTOR_CHANGE_UNSUPPORTED");
        }
      }

      const base = await objectSnapshot(
        control,
        "baselines",
        row.kind,
        row.object,
      );
      const ours = await objectSnapshot(
        control,
        "objects",
        row.resultKind,
        row.resultObject,
      );
      const current = await snapshot(source, name);
      signal.throwIfAborted();
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

      totalBytes += [
        base.content,
        ours.content,
        current.content,
        preview.state === "merged" ? preview.content : null,
      ].reduce<number>(
        (sum, content) =>
          sum + (content === null ? 0 : Buffer.byteLength(content, "base64")),
        0,
      );
      if (totalBytes > 16 * 1024 * 1024) {
        throw new PublishError("REVIEW_CONTENT_LIMIT");
      }

      files.push({
        path: name,
        epoch: state.epoch,
        version: digest(
          JSON.stringify({ source, control, state, row, base, ours, current }),
        ),
        base,
        ours,
        current,
        preview,
        publicationChecked: false,
      });
    }

    // This detects changes during the bounded read; it is not an atomic source
    // snapshot or a lock against external writers after the final check.
    for (const file of files) {
      signal.throwIfAborted();
      if (
        (await snapshot(source, file.path)).version !== file.current.version
      ) {
        throw new PublishError("READ_CHANGED");
      }
    }

    const after = await lstat(database, { bigint: true });
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    ) {
      throw new PublishError("READ_CHANGED");
    }

    files.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );

    return {
      version: digest(
        JSON.stringify(
          files.map((file) => ({ path: file.path, version: file.version })),
        ),
      ),
      files,
      publicationChecked: false,
    };
  } finally {
    db.close();
  }
}
