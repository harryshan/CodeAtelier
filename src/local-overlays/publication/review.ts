/**
 * 已正常卸载的 Local 私有修改检查，供 LocalOverlayService 的排他只读租约调用。
 * 1. 检查 v6 clean 卷、来源身份和封存标识；只查询显式指定的一个路径，不扫描文件树。
 * 2. 读取不可变 B、封存 O 与当前 T，各自沿用普通单链接文件和 2 MiB 限制。
 * 3. 生成纯内容合并预览和材料版本摘要；不验证读依赖、运行候选命令或签发发布授权。
 * 4. 始终关闭只读 SQLite 事务；不挂载、清空依赖、刷新视图、解除发布锁或写来源。
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
  checkRelative(selected);
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
    const raw = db
      .prepare(
        "SELECT b.*,s.kind AS resultKind,s.object AS resultObject " +
          "FROM baselines b JOIN sealed_changes s ON s.path=b.path " +
          "WHERE b.name COLLATE NOCASE=?",
      )
      .get("\\" + selected.replaceAll("/", "\\"));
    if (!raw) {
      throw new PublishError("NATIVE_CHANGE_MISSING");
    }

    const row = rowSchema.parse(raw);
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

    return {
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
    };
  } finally {
    db.close();
  }
}
