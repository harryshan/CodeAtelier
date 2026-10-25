/**
 * 发布日志的有界读取与结构校验，供 Publisher 的观察和完成态刷新恢复使用。
 * 1. loadJournal 拒绝链接/非文件/过大日志，并返回原始摘要作为后续私有写入的版本前提。
 * 2. parseJournal 校验批次、逐文件正文编码/状态与确认请求的路径归属，不相信反序列化类型断言。
 * 3. saveJournal 在来源协调锁内复核日志摘要，再沿用 durableJson 保存；不改来源文件。
 * 字段保留兼容现有实验日志；没有检查点的旧日志不能凭空生成刷新证明。外部写者不受应用锁约束。
 */
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import {
  validateOverlayAcknowledgement,
  type OverlayAcknowledgement,
} from "../../src/worktrees/overlay.js";
import { digest, durableJson, type Snapshot } from "./files.js";
import { MAX_BYTES, PublishError } from "./merge.js";
import { checkpointSchema, type NativeCheckpoint } from "./native-refresh.js";
import { validateBatch, type Batch } from "./session.js";

export interface Entry {
  path: string;
  before: Snapshot;
  after: string | null;
  state: "pending" | "intent" | "written" | "unchanged";
  backup?: { path: string; identity?: string; cleaned?: boolean };
}
export interface Journal {
  version?: 1;
  batch: Batch;
  state: "prepared" | "applying" | "complete" | "aborted" | "unknown";
  entries: Entry[];
  refresh?: {
    request: OverlayAcknowledgement;
    checkpoint?: NativeCheckpoint;
    state: "pending" | "confirmed";
    attempts?: {
      request: OverlayAcknowledgement;
      state: "intent" | "confirmed";
    }[];
  };
}

const content = z
  .string()
  .max(Math.ceil(MAX_BYTES / 3) * 4)
  .nullable()
  .refine(
    (value) =>
      value === null ||
      Buffer.from(value, "base64").toString("base64") === value,
  );
const acknowledgement = z.unknown().transform(validateOverlayAcknowledgement);
const schema = z.object({
  version: z.literal(1).optional(),
  batch: z.unknown().transform(validateBatch),
  state: z.enum(["prepared", "applying", "complete", "aborted", "unknown"]),
  entries: z
    .array(
      z.object({
        path: z.string(),
        before: z.object({
          content,
          version: z.string(),
          mode: z.number().int().min(0).max(0o777).nullable(),
        }),
        after: content,
        state: z.enum(["pending", "intent", "written", "unchanged"]),
        backup: z
          .object({
            path: z.string(),
            identity: z.string().optional(),
            cleaned: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(100),
  refresh: z
    .object({
      request: acknowledgement,
      checkpoint: checkpointSchema.optional(),
      state: z.enum(["pending", "confirmed"]),
      attempts: z
        .array(
          z.object({
            request: acknowledgement,
            state: z.enum(["intent", "confirmed"]),
          }),
        )
        .max(100)
        .optional(),
    })
    .optional(),
});

export function parseJournal(value: unknown): Journal {
  const journal = schema.parse(value);
  const paths = journal.batch.changes.map((change) => change.path);
  if (
    JSON.stringify(paths) !==
    JSON.stringify(journal.entries.map((entry) => entry.path))
  ) {
    throw new PublishError("JOURNAL_BATCH_MISMATCH");
  }

  if (
    journal.state === "complete" &&
    journal.entries.some(
      (entry) => entry.state !== "written" && entry.state !== "unchanged",
    )
  ) {
    throw new PublishError("JOURNAL_INCOMPLETE_ENTRIES");
  }

  for (const request of journal.refresh
    ? [
        journal.refresh.request,
        ...(journal.refresh.attempts ?? []).map((attempt) => attempt.request),
      ]
    : []) {
    if (
      request.batchId !== journal.batch.id ||
      JSON.stringify(request.paths) !==
        JSON.stringify(paths.map((file) => "\\" + file.replaceAll("/", "\\")))
    ) {
      throw new PublishError("REFRESH_BATCH_MISMATCH");
    }
  }

  return journal;
}

export async function loadJournal(file: string, batch: Batch) {
  const info = await lstat(file, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    info.size > 128n * 1024n * 1024n
  ) {
    throw new PublishError("JOURNAL_TYPE_OR_LIMIT");
  }

  const stamp = (value: typeof info) =>
    `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.nlink}`;
  const handle = await open(file, "r");
  let bytes: Buffer;
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(info)) {
      throw new PublishError("JOURNAL_CHANGED");
    }

    const buffer = Buffer.alloc(Number(info.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!result.bytesRead) {
        break;
      }

      length += result.bytesRead;
    }

    if (
      length !== Number(info.size) ||
      stamp(await handle.stat({ bigint: true })) !== stamp(info) ||
      stamp(await lstat(file, { bigint: true })) !== stamp(info)
    ) {
      throw new PublishError("JOURNAL_CHANGED");
    }

    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }

  const journal = parseJournal(JSON.parse(bytes.toString("utf8")));
  if (
    digest(JSON.stringify(journal.batch)) !==
    digest(JSON.stringify(validateBatch(batch)))
  ) {
    throw new PublishError("JOURNAL_BATCH_MISMATCH");
  }

  return { journal, version: digest(bytes) };
}

export async function saveJournal(
  file: string,
  journal: Journal,
  expected: string,
) {
  if ((await loadJournal(file, journal.batch)).version !== expected) {
    throw new PublishError("JOURNAL_CHANGED");
  }

  parseJournal(journal);
  await durableJson(file, journal);

  return digest(JSON.stringify(journal, null, 2) + "\n");
}
