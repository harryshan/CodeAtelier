/**
 * 候选工程验证结束后的读取凭据，供 CandidateValidator 与 Publisher 共享。
 * 1. ValidationReceipt 只携带有界来源文件版本；validateReceipt 拒绝越界、重复或空版本。
 * 2. candidateReads 在候选冻结租约内核对来源/格式、采集未选文件版本，再复核原生观察。
 * 3. 验证过程私有写入的其它文件仍保留其来源读依赖，不把测试生成物当作发布内容。
 * 4. CandidateCleanupUnknownError 标记进程或卷排空未知；Publisher 必须保留原会话而非普通拒绝续聊。
 * 不枚举来源、不执行命令；目录/缺失路径/工作区外读取不属于当前普通文件凭据。
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  bytes,
  checkRelative,
  snapshot,
  sourceIdentity,
  type Source,
} from "./publication/files.js";
import { PublishError } from "./publication/merge.js";

const receiptSchema = z.object({
  reads: z
    .array(z.object({ path: z.string(), version: z.string().min(1).max(1024) }))
    .max(100),
});
export type ValidationReceipt = z.infer<typeof receiptSchema>;

export class CandidateCleanupUnknownError extends Error {
  constructor(cause?: unknown) {
    super("候选验证进程或文件系统排空未确认；保留现场。", { cause });
    this.name = "CandidateCleanupUnknownError";
  }
}

export function validateReceipt(input: unknown): ValidationReceipt {
  const result = receiptSchema.parse(input);
  const keys = new Set<string>();
  for (const read of result.reads) {
    checkRelative(read.path);
    const key = read.path.toLowerCase();
    if (keys.has(key)) {
      throw new PublishError("DUPLICATE_PATH");
    }

    keys.add(key);
  }

  return result;
}

export async function candidateReads(
  source: Source,
  control: string,
  candidates: ReadonlyMap<string, Buffer | null>,
  verify: (epochs?: readonly number[]) => Promise<void>,
): Promise<ValidationReceipt> {
  const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
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

    const current = await sourceIdentity(meta.source);
    if (current.root !== source.root || current.identity !== source.identity) {
      throw new PublishError("SOURCE_REPLACED");
    }

    // A candidate is always fresh and may not inherit historical epochs.
    if (db.prepare("SELECT epoch FROM local_state").get()?.epoch !== 0) {
      throw new PublishError("CANDIDATE_EPOCH_INVALID");
    }

    const selectedKeys = new Set<string>();
    const privateSource = await sourceIdentity(control);
    for (const [file, expected] of candidates) {
      checkRelative(file);
      const row = db
        .prepare(
          "SELECT b.path,b.flags,s.kind,s.object FROM baselines b JOIN sealed_changes s ON s.path=b.path WHERE b.name COLLATE NOCASE=?",
        )
        .get("\\" + file.replaceAll("/", "\\"));
      if (typeof row?.path !== "string") {
        throw new PublishError("CANDIDATE_BASELINE_MISSING");
      }

      if (
        typeof row.flags !== "number" ||
        row.flags & 4 ||
        row.kind !== (expected === null ? 0 : 1)
      ) {
        throw new PublishError("CANDIDATE_CHANGED_BY_VALIDATOR");
      }

      if (expected !== null) {
        if (
          typeof row.object !== "string" ||
          !/^\{[0-9a-f-]{36}\}$/i.test(row.object)
        ) {
          throw new PublishError("NATIVE_OBJECT_INVALID");
        }

        const actual = bytes(
          await snapshot(privateSource, `objects/${row.object}`),
        );
        if (!actual?.equals(expected)) {
          throw new PublishError("CANDIDATE_CHANGED_BY_VALIDATOR");
        }
      }

      selectedKeys.add(row.path);
    }

    const observed = db
      .prepare("SELECT path,name,epoch FROM observations LIMIT 101")
      .all();
    if (observed.length > 100) {
      throw new PublishError("READ_LIMIT");
    }

    const reads: ValidationReceipt["reads"] = [];
    const keys: string[] = [];
    for (const row of observed) {
      if (
        typeof row.path !== "string" ||
        typeof row.name !== "string" ||
        row.epoch !== 0 ||
        !row.name.startsWith("\\")
      ) {
        throw new PublishError("NATIVE_PATH_INVALID");
      }

      if (selectedKeys.has(row.path)) {
        continue;
      }

      const file = row.name.slice(1).replaceAll("\\", "/");
      reads.push({
        path: file,
        version: (await snapshot(source, file)).version,
      });
      keys.push(row.path);
    }

    // Hash the current file first, then prove it still matches what the command read.
    await verify([0]);
    for (const key of keys) {
      if (
        db
          .prepare("SELECT valid FROM checked_reads WHERE path=? AND epoch=0")
          .get(key)?.valid !== 1
      ) {
        throw new PublishError("STALE_VALIDATION_DEPENDENCY");
      }
    }

    return validateReceipt({ reads });
  } finally {
    db.close();
  }
}
