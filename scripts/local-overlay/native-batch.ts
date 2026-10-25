/**
 * 将已冻结的 Local WinFsp 结果转换为发布 PoC 的明确路径批次。
 * 1. 调用方必须位于 OverlayManager.withFrozen 回调内；校验 v5 来源与私有表，不挂载或自行获取租约。
 * 2. 仅查询选择的路径，读取不可变 B 和封存 O；普通文件有界读取，拒绝目录、重解析和显式属性变更。
 * 3. 对其它已读路径先取宿主内容版本，再经仍持租约的 helper 复核原生观察戳；拒绝失效依赖。
 * 4. 按所选修改的历史代次及当前代次检查依赖，返回 Batch 与绑定的确认请求；不自行发布或确认。
 * 5. 对真正变化的选定路径保存私有检查点，供 complete 后的刷新恢复；额外复核仅限这些文件。
 * 沿用 PoC 的 100 个文件/读依赖/关联代次和内容大小限制，不将全部 upper 当源码。
 * 日志与 trace 由外层冻结/发布生命周期提供，不输出路径、内容或安全描述符。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { OverlayAcknowledgement } from "../../src/worktrees/overlay.js";
import {
  checkRelative,
  digest,
  snapshot,
  sourceIdentity,
  type Source,
} from "./files.js";
import { PublishError } from "./merge.js";
import { validateBatch, type Batch } from "./session.js";
import { nativeCheckpoint, type NativeCheckpoint } from "./native-refresh.js";

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

function relative(native: string) {
  if (!native.startsWith("\\")) {
    throw new PublishError("NATIVE_PATH_INVALID");
  }

  const value = native.slice(1).replaceAll("\\", "/");
  checkRelative(value);

  return value;
}

async function content(control: Source, directory: string, object: string) {
  if (
    !/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(
      object,
    )
  ) {
    throw new PublishError("NATIVE_OBJECT_INVALID");
  }

  const result = await snapshot(control, `${directory}/${object}`);
  if (result.content === null) {
    throw new PublishError("NATIVE_OBJECT_MISSING");
  }

  return result.content;
}

export async function nativeBatch(
  source: Source,
  controlDirectory: string,
  selected: readonly string[],
  verifyReads: (epochs?: readonly number[]) => Promise<void>,
): Promise<
  Batch & {
    acknowledgement: OverlayAcknowledgement;
    checkpoint: NativeCheckpoint;
  }
> {
  if (selected.length < 1 || selected.length > 100) {
    throw new PublishError("BATCH_LIMIT");
  }

  const control = await sourceIdentity(controlDirectory);
  const db = new DatabaseSync(path.join(control.root, "overlay.sqlite"), {
    readOnly: true,
  });
  try {
    const meta = db.prepare("SELECT version,source,clean FROM meta").get();
    if (
      meta?.version !== 5 ||
      meta.clean !== 0 ||
      typeof meta.source !== "string"
    ) {
      throw new PublishError("NATIVE_FORMAT_OR_LEASE");
    }

    const actual = await sourceIdentity(meta.source);
    if (actual.root !== source.root || actual.identity !== source.identity) {
      throw new PublishError("SOURCE_REPLACED");
    }

    const changes: Batch["changes"] = [];
    const epoch = z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000)
      .parse(db.prepare("SELECT epoch FROM local_state").get()?.epoch);
    const epochs = new Set<number>([epoch]);
    const seal = z
      .uuid()
      .parse(db.prepare("SELECT seal FROM local_state").get()?.seal);
    const selectedKeys = new Set<string>();
    const changedKeys = new Set<string>();
    for (const file of selected) {
      checkRelative(file);
      const row = rowSchema.parse(
        db
          .prepare(
            "SELECT b.*,s.kind AS resultKind,s.object AS resultObject " +
              "FROM baselines b JOIN sealed_changes s ON s.path=b.path " +
              "WHERE b.name COLLATE NOCASE=?",
          )
          .get("\\" + file.replaceAll("/", "\\")),
      );
      // Use the native invariant-folded key, not SQLite's ASCII-only NOCASE,
      // when checking ancestors of paths whose spelling came from Windows.
      const parts = row.path.split("\\");
      for (let count = 2; count < parts.length; count++) {
        const ancestor = parts.slice(0, count).join("\\");
        if (
          db.prepare("SELECT path FROM baselines WHERE path=?").get(ancestor)
        ) {
          throw new PublishError("NATIVE_ANCESTOR_CHANGE_UNSUPPORTED");
        }
      }

      if (selectedKeys.has(row.path)) {
        throw new PublishError("DUPLICATE_PATH");
      }

      selectedKeys.add(row.path);
      const associations = db
        .prepare("SELECT epoch FROM change_epochs WHERE path=? LIMIT 101")
        .all(row.path);
      if (associations.length === 0) {
        throw new PublishError("NATIVE_CHANGE_EPOCH_MISSING");
      }

      for (const association of associations) {
        epochs.add(z.number().int().min(0).max(epoch).parse(association.epoch));
      }

      if (epochs.size > 100) {
        throw new PublishError("READ_LIMIT");
      }

      if (
        row.flags & 4 ||
        ![0, 1].includes(row.kind) ||
        ![0, 1].includes(row.resultKind)
      ) {
        throw new PublishError("NATIVE_CHANGE_UNSUPPORTED");
      }

      const base =
        row.kind === 0 ? null : await content(control, "baselines", row.object);
      const ours =
        row.resultKind === 0
          ? null
          : await content(control, "objects", row.resultObject);
      if (base === ours) {
        continue;
      }

      changedKeys.add(row.path);
      changes.push({
        path: relative(row.name),
        base: {
          content: base,
          version: `native:${row.stamp}:${digest(base ?? "missing")}`,
          mode: row.kind === 0 ? null : row.attributes & 1 ? 0o444 : 0o666,
        },
        ours,
      });
    }

    const observations = db
      .prepare(
        `SELECT path,name,epoch FROM observations WHERE epoch IN (${[...epochs].map(() => "?").join(",")}) LIMIT 101`,
      )
      .all(...epochs);
    if (observations.length > 100) {
      throw new PublishError("READ_LIMIT");
    }

    const reads: Batch["reads"] = [];
    const dependencyKeys: { path: string; epoch: number }[] = [];
    for (const raw of observations) {
      const observed = z
        .object({ path: z.string(), name: z.string(), epoch: z.number().int() })
        .parse(raw);
      if (changedKeys.has(observed.path)) {
        continue;
      }

      const file = relative(observed.name);
      const current = await snapshot(source, file);
      reads.push({ path: file, version: current.version });
      dependencyKeys.push(observed);
    }

    // Source snapshots cannot reconstruct the old read version. Check the
    // original native observations after collecting those snapshots instead.
    await verifyReads([...epochs]);
    for (const key of dependencyKeys) {
      if (
        db
          .prepare("SELECT valid FROM checked_reads WHERE path=? AND epoch=?")
          .get(key.path, key.epoch)?.valid !== 1
      ) {
        throw new PublishError("STALE_DEPENDENCY");
      }
    }

    const batch = validateBatch({ id: randomUUID(), source, changes, reads });
    const paths = batch.changes.map(
      (change) => "\\" + change.path.replaceAll("/", "\\"),
    );
    const checkpoint = await nativeCheckpoint(source, controlDirectory, paths);

    return {
      ...batch,
      checkpoint,
      acknowledgement: {
        batchId: batch.id,
        seal,
        epoch,
        paths,
      },
    };
  } finally {
    db.close();
  }
}
