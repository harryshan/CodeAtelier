/**
 * 已完成来源发布的私有视图恢复证明，供原生批次导出与 Publisher 的恢复回调使用。
 * 1. nativeCheckpoint 仅在冻结租约内记录所选 B/O 映射、修改代次及私有文件版本，不遍历来源。
 * 2. nativeRefreshRequest 校验 v6 来源/控制目录；已有完全匹配的原生收据优先幂等返回。
 * 3. 未执行的确认必须保有检查点且私有状态逐项未变，才绑定当前冻结标识；后来修改一律保留。
 * 4. 本模块只读取 SQLite/有界私有普通文件；不写来源、不执行确认、不恢复 dirty 卷或解除未知发布锁。
 * 调用方持有 OverlayManager.withFrozen 租约并核对来源 complete；外层负责日志、取消与恢复 tracing。
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  validateOverlayAcknowledgement,
  type OverlayAcknowledgement,
} from "../../src/worktrees/overlay.js";
import {
  checkRelative,
  digest,
  snapshot,
  sourceIdentity,
  type Source,
} from "./files.js";
import { PublishError } from "./merge.js";

export const checkpointSchema = z.object({
  control: z.object({ root: z.string(), identity: z.string() }),
  files: z
    .array(
      z.object({
        key: z.string(),
        name: z.string(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(100),
});
export type NativeCheckpoint = z.infer<typeof checkpointSchema>;

async function openFrozen(source: Source, directory: string) {
  const control = await sourceIdentity(directory);
  const db = new DatabaseSync(path.join(control.root, "overlay.sqlite"), {
    readOnly: true,
  });
  try {
    const meta = db.prepare("SELECT version,source,clean FROM meta").get();
    if (
      meta?.version !== 6 ||
      meta.clean !== 0 ||
      typeof meta.source !== "string"
    ) {
      throw new PublishError("NATIVE_FORMAT_OR_LEASE");
    }

    const actual = await sourceIdentity(meta.source);
    if (actual.root !== source.root || actual.identity !== source.identity) {
      throw new PublishError("SOURCE_REPLACED");
    }

    return { db, control };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function objectVersion(
  control: Source,
  directory: string,
  kind: unknown,
  object: unknown,
) {
  if (kind === 0 && object === "") {
    return "missing";
  }

  if (
    kind !== 1 ||
    typeof object !== "string" ||
    !/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(
      object,
    )
  ) {
    throw new PublishError("NATIVE_CHANGE_UNSUPPORTED");
  }

  const found = await snapshot(control, `${directory}/${object}`);
  if (found.content === null) {
    throw new PublishError("NATIVE_OBJECT_MISSING");
  }

  return found.version;
}

async function fileCheckpoint(db: DatabaseSync, control: Source, name: string) {
  if (!name.startsWith("\\")) {
    throw new PublishError("NATIVE_PATH_INVALID");
  }

  checkRelative(name.slice(1).replaceAll("\\", "/"));
  const row = db
    .prepare(
      "SELECT b.*,s.kind AS resultKind,s.object AS resultObject FROM baselines b JOIN sealed_changes s ON s.path=b.path WHERE b.name COLLATE NOCASE=?",
    )
    .get(name);
  if (
    !row ||
    typeof row.path !== "string" ||
    typeof row.name !== "string" ||
    typeof row.flags !== "number" ||
    row.flags & 4
  ) {
    throw new PublishError("NATIVE_REFRESH_CHANGED");
  }

  const epochs = db
    .prepare(
      "SELECT epoch FROM change_epochs WHERE path=? ORDER BY epoch LIMIT 101",
    )
    .all(row.path);
  if (epochs.length === 0 || epochs.length > 100) {
    throw new PublishError("NATIVE_REFRESH_CHANGED");
  }

  const before = await objectVersion(
    control,
    "baselines",
    row.kind,
    row.object,
  );
  const after = await objectVersion(
    control,
    "objects",
    row.resultKind,
    row.resultObject,
  );

  return {
    key: row.path,
    name: row.name,
    fingerprint: digest(JSON.stringify({ row, epochs, before, after })),
  };
}

export async function nativeCheckpoint(
  source: Source,
  directory: string,
  paths: readonly string[],
): Promise<NativeCheckpoint> {
  if (!paths.length || paths.length > 100) {
    throw new PublishError("BATCH_LIMIT");
  }

  const { db, control } = await openFrozen(source, directory);
  try {
    const files = [];
    for (const name of paths) {
      files.push(await fileCheckpoint(db, control, name));
    }

    return checkpointSchema.parse({ control, files });
  } finally {
    db.close();
  }
}

export async function nativeRefreshRequest(
  source: Source,
  directory: string,
  input: OverlayAcknowledgement,
  proof?: NativeCheckpoint,
): Promise<OverlayAcknowledgement> {
  const request = validateOverlayAcknowledgement(input);
  const { db, control } = await openFrozen(source, directory);
  try {
    const receipt = db
      .prepare("SELECT epoch,seal FROM acknowledgements WHERE id=?")
      .get(request.batchId);
    if (receipt) {
      if (receipt.epoch !== request.epoch || receipt.seal !== request.seal) {
        throw new PublishError("NATIVE_RECEIPT_MISMATCH");
      }

      // Native acknowledge still checks the entire canonical selection. Do not
      // infer success from this read alone or synthesize a host confirmation.
      return request;
    }

    if (!proof) {
      throw new PublishError("NATIVE_CHECKPOINT_MISSING");
    }

    const checkpoint = checkpointSchema.parse(proof);
    if (
      checkpoint.control.root !== control.root ||
      checkpoint.control.identity !== control.identity ||
      JSON.stringify(checkpoint.files.map((file) => file.name)) !==
        JSON.stringify(request.paths)
    ) {
      throw new PublishError("NATIVE_CHECKPOINT_MISMATCH");
    }

    for (const expected of checkpoint.files) {
      const actual = await fileCheckpoint(db, control, expected.name);
      if (
        actual.key !== expected.key ||
        actual.fingerprint !== expected.fingerprint
      ) {
        throw new PublishError("NATIVE_REFRESH_CHANGED");
      }
    }

    const state = z
      .object({
        epoch: z.number().int().min(0).max(1_000_000_000),
        seal: z.uuid(),
      })
      .parse(db.prepare("SELECT epoch,seal FROM local_state").get());

    return { ...request, ...state };
  } finally {
    db.close();
  }
}
