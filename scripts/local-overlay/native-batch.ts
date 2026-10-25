/**
 * 将已冻结的 Local WinFsp 结果转换为发布 PoC 的明确路径批次。
 * 1. 调用方必须位于 OverlayManager.withFrozen 回调内；校验 v4 来源与私有表，不挂载或自行获取租约。
 * 2. 仅查询选择的路径，读取不可变 B 和封存 O；普通文件有界读取，拒绝目录、重解析和显式属性变更。
 * 3. 对其它已读路径先取宿主内容版本，再经仍持租约的 helper 复核原生观察戳；拒绝失效依赖。
 * 4. 返回已验证 Batch；不写来源、不确认发布、不刷新观察周期，也不将全部 upper 当源码。
 * 沿用 PoC 的 100 个文件/读依赖和内容大小限制；Windows ACL 保真发布另行接入。
 * 日志与 trace 由外层冻结/发布生命周期提供，不输出路径、内容或安全描述符。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  checkRelative,
  digest,
  snapshot,
  sourceIdentity,
  type Source,
} from "./files.js";
import { PublishError } from "./merge.js";
import { validateBatch, type Batch } from "./session.js";

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
  verifyReads: () => Promise<void>,
): Promise<Batch> {
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
      meta?.version !== 4 ||
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
      .prepare("SELECT path,name FROM observations LIMIT 101")
      .all();
    if (observations.length > 100) {
      throw new PublishError("READ_LIMIT");
    }

    const reads: Batch["reads"] = [];
    const dependencyKeys: string[] = [];
    for (const raw of observations) {
      const observed = z
        .object({ path: z.string(), name: z.string() })
        .parse(raw);
      if (changedKeys.has(observed.path)) {
        continue;
      }

      const file = relative(observed.name);
      const current = await snapshot(source, file);
      reads.push({ path: file, version: current.version });
      dependencyKeys.push(observed.path);
    }

    // Source snapshots cannot reconstruct the old read version. Check the
    // original native observations after collecting those snapshots instead.
    await verifyReads();
    for (const key of dependencyKeys) {
      if (
        db.prepare("SELECT valid FROM checked_reads WHERE path=?").get(key)
          ?.valid !== 1
      ) {
        throw new PublishError("STALE_DEPENDENCY");
      }
    }

    return validateBatch({ id: randomUUID(), source, changes, reads });
  } finally {
    db.close();
  }
}
