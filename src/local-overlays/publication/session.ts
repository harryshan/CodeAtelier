/**
 * Local 发布批次契约和普通目录测试会话；生产 nativeBatch/Publisher 共用批次验证，EditSession 仅供受控实验。
 * 1. read 保存真实来源版本；已有私有修改返回会话内容，调用方不能改写基线 Buffer。
 * 2. edit 在第一次修改前复核读版本，保存 B/O；其它会话此后的变化留给发布三方检查。
 * 3. validateBatch 校验路径、重复项、内容与数量限额；seal 生成明确路径和读依赖，save/load 供独占实验及子进程。
 *    原生目录读集允许 directory 类型的根路径；普通文件编辑仍禁止点路径。
 * 不运行 Git、不扫描目录、不截获 shell；发布完成后应创建新会话，PoC 不实现续轮 rebase。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  bytes,
  checkRelative,
  durableJson,
  snapshot,
  type Snapshot,
  type Source,
} from "./files.js";
import { MAX_BYTES, PublishError } from "./merge.js";
import { readSetSchema } from "./read-set.js";
import { checkReadPath } from "./read-version.js";

const snapshotSchema = z.object({
  content: z
    .string()
    .max(Math.ceil(MAX_BYTES / 3) * 4)
    .nullable(),
  version: z.string(),
  mode: z.number().int().min(0).max(0o777).nullable(),
});

const batchSchema = z.object({
  id: z.uuid(),
  source: z.object({ root: z.string(), identity: z.string() }),
  changes: z
    .array(
      z.object({
        path: z.string(),
        base: snapshotSchema,
        ours: z.string().nullable(),
      }),
    )
    .min(1)
    .max(100),
  reads: readSetSchema,
});
export type Batch = z.infer<typeof batchSchema>;

export function validateBatch(value: unknown): Batch {
  const batch = batchSchema.parse(value);
  let size = 0;
  const paths = new Set<string>();
  for (const change of batch.changes) {
    checkRelative(change.path);
    const key = change.path.toLowerCase();
    if (paths.has(key)) {
      throw new PublishError("DUPLICATE_PATH");
    }

    paths.add(key);
    for (const content of [change.base.content, change.ours]) {
      if (content !== null) {
        const decoded = Buffer.from(content, "base64");
        if (
          decoded.length > MAX_BYTES ||
          decoded.toString("base64") !== content
        ) {
          throw new PublishError("FILE_LIMIT");
        }

        size += decoded.length;
      }
    }
  }

  for (const read of batch.reads) {
    checkReadPath(read);
  }

  if (size > 16 * 1024 * 1024) {
    throw new PublishError("BATCH_LIMIT");
  }

  return batch;
}

export async function loadBatch(file: string) {
  const content = await readFile(file);
  if (content.length > 32 * 1024 * 1024) {
    throw new PublishError("BATCH_LIMIT");
  }

  return validateBatch(JSON.parse(content.toString("utf8")));
}

export class EditSession {
  readonly id = randomUUID();
  private readonly reads = new Map<string, Snapshot>();
  private readonly edits = new Map<
    string,
    { base: Snapshot; ours: string | null }
  >();

  constructor(readonly source: Source) {}

  async read(relative: string) {
    const edit = this.edits.get(relative);
    if (edit) {
      return edit.ours === null ? null : Buffer.from(edit.ours, "base64");
    }

    if (!this.reads.has(relative) && this.reads.size >= 100) {
      throw new PublishError("READ_LIMIT");
    }

    const current = await snapshot(this.source, relative);
    this.reads.set(relative, current);

    return bytes(current);
  }

  async edit(relative: string, content: Buffer | null) {
    if (content && content.length > MAX_BYTES) {
      throw new PublishError("FILE_LIMIT");
    }

    const existing = this.edits.get(relative);
    const base = existing?.base ?? this.reads.get(relative);
    if (!base) {
      throw new PublishError("READ_REQUIRED");
    }

    if (
      !existing &&
      (await snapshot(this.source, relative)).version !== base.version
    ) {
      throw new PublishError("STALE_READ");
    }

    this.edits.set(relative, {
      base: { ...base },
      ours: content?.toString("base64") ?? null,
    });
  }

  seal(): Batch {
    return validateBatch({
      id: this.id,
      source: this.source,
      changes: [...this.edits].map(([file, edit]) => ({ path: file, ...edit })),
      reads: [...this.reads]
        .filter(([file]) => !this.edits.has(file))
        .map(([file, read]) => ({ path: file, version: read.version })),
    });
  }

  async save(file: string) {
    await durableJson(file, this.seal());
  }
}
