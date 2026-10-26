/**
 * 中断 Local 私有层的有界只读检查，供恢复 PoC 及后续产品恢复入口使用。
 * 1. inspectInterruptedFiles 先取得原生进程/文件租约，生命周期含取消、耗时、ID 和私有 trace。
 * 2. readInterruptedFiles 读取 v6 SQLite 一致事务及明确路径的当前 namespace，不相信旧 sealed_changes。
 *    currentPrivateObject 沿 entries/nodes 校验路径键和类型，缺节点或祖先修改不猜测实际结果。
 * 3. 原文来自不可变 baselines，私有内容来自当前 objects；目录/链接/属性操作/祖先变更或无对象均拒绝。
 * 4. 每份 2 MiB、整组 16 MiB，数据库/旁文件限制类型与大小，quick_check 检查私有元数据，不扫描来源树。
 *    SQLite 仅打开 inspection-database 创建的 main/WAL 副本，避免只读连接也创建原卷旁文件。
 * 输出始终标记 interrupted，不提供合并预览/完成写证明或发布授权。中断时文件可能只写了一部分。
 * 原卷/clean/服务锁不变，不恢复任务或解除发布事故；元数据损坏或证明缺失保留并拒绝，不猜测。
 */
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";
import { z } from "zod";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";
import { withLocalInspection } from "./inspection-lease.js";
import {
  checkRelative,
  digest,
  snapshot,
  sourceIdentity,
  type Snapshot,
  type Source,
} from "./publication/files.js";
import { PublishError } from "./publication/merge.js";
import { reviewSelection } from "./publication/review.js";
import { withInspectionDatabase } from "./inspection-database.js";
import { inside } from "../tools/paths.js";

const baselineSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.union([z.literal(0), z.literal(1)]),
  object: z.string(),
  flags: z.number().int().nonnegative(),
});

export interface InterruptedReview {
  state: "interrupted";
  publicationChecked: false;
  version: string;
  files: { path: string; base: Snapshot; private: Snapshot }[];
}

async function privateFile(
  control: Source,
  directory: string,
  object: string,
): Promise<Snapshot> {
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

function currentPrivateObject(
  db: DatabaseSync,
  baseline: z.infer<typeof baselineSchema>,
) {
  const name = baseline.name.slice(1).replaceAll("\\", "/");
  const parts = checkRelative(name);
  const keysParts = baseline.path.split("\\");
  let parent = 1;
  let nativePath = "";
  let object = "";
  let deleted = false;
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (
      !last &&
      db
        .prepare("SELECT 1 FROM baselines WHERE path=?")
        .get(keysParts.slice(0, index + 2).join("\\"))
    ) {
      throw new PublishError("NATIVE_ANCESTOR_CHANGE_UNSUPPORTED");
    }

    const entries = db
      .prepare(
        "SELECT node,key FROM entries WHERE parent=? AND name COLLATE NOCASE=? LIMIT 2",
      )
      .all(parent, part);
    if (
      entries.length !== 1 ||
      typeof entries[0]?.node !== "number" ||
      typeof entries[0]?.key !== "string"
    ) {
      throw new PublishError("NATIVE_NAMESPACE_INVALID");
    }

    nativePath += "\\" + entries[0].key;
    if (last && nativePath !== baseline.path) {
      throw new PublishError("NATIVE_NAMESPACE_INVALID");
    }

    const id = entries[0].node;
    if (last && id === 0) {
      deleted = true;
      break;
    }

    const node = db
      .prepare("SELECT object,info,reparse FROM nodes WHERE id=?")
      .get(id);
    if (
      !node ||
      typeof node.object !== "string" ||
      !(node.info instanceof Uint8Array) ||
      node.info.byteLength < 4 ||
      (node.reparse !== null &&
        (!(node.reparse instanceof Uint8Array) || node.reparse.byteLength))
    ) {
      throw new PublishError("NATIVE_NAMESPACE_INVALID");
    }

    const attributes = Buffer.from(node.info).readUInt32LE(0);
    if (attributes & 0x400 || Boolean(attributes & 0x10) === last) {
      throw new PublishError("NATIVE_CHANGE_UNSUPPORTED");
    }

    parent = id;
    object = node.object;
  }

  return deleted ? null : object;
}

/** Caller must hold the native inspection lease for the entire transaction. */
export async function readInterruptedFiles(
  source: Source,
  control: Source,
  requested: readonly string[],
  signal: AbortSignal,
  temporaryRoot: string,
): Promise<InterruptedReview> {
  const selection = reviewSelection(requested);
  if (
    inside(source.root, path.resolve(temporaryRoot)) ||
    inside(control.root, path.resolve(temporaryRoot))
  ) {
    throw new PublishError("INSPECTION_DIRECTORY_INVALID");
  }

  const database = path.join(control.root, "overlay.sqlite");
  const checkDatabase = async () => {
    signal.throwIfAborted();
    const actual = await sourceIdentity(control.root);
    if (actual.root !== control.root || actual.identity !== control.identity) {
      throw new PublishError("CONTROL_REPLACED");
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        const info = await lstat(database + suffix);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          info.size > 256 * 1024 * 1024
        ) {
          throw new PublishError("NATIVE_DATABASE_INVALID");
        }
      } catch (error: any) {
        if (suffix && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }
  };

  await checkDatabase();
  const before = await lstat(database, { bigint: true });

  return withInspectionDatabase(
    database,
    temporaryRoot,
    signal,
    [source.root, control.root],
    async (copy) => {
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        db.exec("BEGIN");
        const health = db.prepare("PRAGMA quick_check(1)").get();
        if (!health || Object.values(health)[0] !== "ok") {
          throw new PublishError("NATIVE_DATABASE_INVALID");
        }

        const meta = db.prepare("SELECT version,source,clean FROM meta").get();
        if (
          meta?.version !== 6 ||
          (meta.clean !== 0 && meta.clean !== 1) ||
          typeof meta.source !== "string"
        ) {
          throw new PublishError("NATIVE_FORMAT_OR_LEASE");
        }

        const actual = await sourceIdentity(meta.source);
        if (
          actual.root !== source.root ||
          actual.identity !== source.identity
        ) {
          throw new PublishError("SOURCE_REPLACED");
        }

        const files: InterruptedReview["files"] = [];
        const keys = new Set<string>();
        let size = 0;
        const missing: Snapshot = {
          content: null,
          version: "missing",
          mode: null,
        };
        for (const selected of selection) {
          signal.throwIfAborted();
          const baseline = baselineSchema.parse(
            db
              .prepare(
                "SELECT path,name,kind,object,flags FROM baselines WHERE name COLLATE NOCASE=?",
              )
              .get("\\" + selected.replaceAll("/", "\\")),
          );
          if (
            baseline.flags & 4 ||
            !baseline.name.startsWith("\\") ||
            keys.has(baseline.path)
          ) {
            throw new PublishError("NATIVE_CHANGE_UNSUPPORTED");
          }

          keys.add(baseline.path);
          const name = baseline.name.slice(1).replaceAll("\\", "/");
          const object = currentPrivateObject(db, baseline);
          const base =
            baseline.kind === 0
              ? missing
              : await privateFile(control, "baselines", baseline.object);
          const ours =
            object === null
              ? missing
              : await privateFile(control, "objects", object);
          size += [base, ours].reduce(
            (total, value) =>
              total +
              (value.content === null
                ? 0
                : Buffer.byteLength(value.content, "base64")),
            0,
          );
          if (size > 16 * 1024 * 1024) {
            throw new PublishError("REVIEW_CONTENT_LIMIT");
          }

          files.push({ path: name, base, private: ours });
        }

        await checkDatabase();
        const after = await lstat(database, { bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        ) {
          throw new PublishError("READ_CHANGED");
        }

        signal.throwIfAborted();

        return {
          state: "interrupted",
          publicationChecked: false,
          version: digest(JSON.stringify({ source, control, files })),
          files,
        };
      } finally {
        db.close();
      }
    },
  );
}

export async function inspectInterruptedFiles(
  source: Source,
  control: Source,
  paths: readonly string[],
  options: { signal: AbortSignal; log: Logger; traceDirectory: string },
): Promise<InterruptedReview> {
  reviewSelection(paths);
  if (
    inside(source.root, path.resolve(options.traceDirectory)) ||
    inside(control.root, path.resolve(options.traceDirectory))
  ) {
    throw new PublishError("INSPECTION_DIRECTORY_INVALID");
  }

  const operationId = randomUUID();
  const trace = new TraceRecorder();
  trace.startTask(operationId, operationId);
  const span = trace.startSpan(operationId, {
    name: "local_overlay.interrupted_review",
    category: "worktree",
    track: "Local recovery",
    attributes: { operationId },
  });
  const started = performance.now();
  let outcome: "ok" | "error" | "cancelled" = "error";
  options.log.info({
    module: "local-overlay",
    event: "interrupted_review.started",
    operationId,
  });
  try {
    const result = await withLocalInspection(
      control.root,
      options.signal,
      (signal) =>
        readInterruptedFiles(
          source,
          control,
          paths,
          signal,
          path.join(options.traceDirectory, "snapshots"),
        ),
    );
    outcome = "ok";

    return result;
  } catch (error) {
    outcome = options.signal.aborted ? "cancelled" : "error";
    throw error;
  } finally {
    trace.endSpan(span, outcome);
    trace.finishTask(operationId, outcome);
    await new TraceArchive(options.traceDirectory, options.log)
      .write(operationId, operationId, trace.exportTask(operationId))
      .catch((err) =>
        options.log.warn({
          module: "local-overlay",
          event: "interrupted_review.trace_failed",
          operationId,
          err,
        }),
      );
    options.log.info({
      module: "local-overlay",
      event: "interrupted_review.finished",
      operationId,
      outcome,
      durationMs: performance.now() - started,
    });
  }
}
