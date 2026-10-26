/**
 * 将 Linux 只读 lower 的一次性观察清单转换为现有 Publisher 批次。
 * 1. readPosixManifest 有界读取并核对清单句柄/路径版本，严格校验格式、来源与 seal ID。
 * 2. readBase 从捕获对象和原始 stamp 重建 B；未读正文仅在来源观察版本未变时补读。
 * 3. capturedReadVersion 对捕获的只读依赖流式重建版本，允许来源硬链接和最多 16 MiB 正文；缓存须单链接且身份匹配。
 *    posixReads 导出文件/目录依赖，目录沿用 Publisher 名称/类型摘要，拒绝来源过期，不将只读依赖转成可发布 B。
 * 4. posixBatch 只读取明确选集的私有结果，优先保留先前轮次 B 并验证历史依赖。
 * 5. posixBaseline 由原生记录或已观察祖先的缺失成员证明 B，不读取私有生成物。
 * 调用方须先排空 Runtime、独占视图并取得 helper seal；本模块不冻结挂载、不发布，
 * 也不从清单推断进程退出。正式 Linux backend 和手动实验共用此桥接。
 * I/O 不扫描整树，受既有内容/读集预算限制；tracing 由外层冻结/发布生命周期提供。
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  bytes,
  checkedPath,
  digest,
  snapshot,
  sourceIdentity,
  type Snapshot,
  type Source,
} from "./publication/files.js";
import { PublishError } from "./publication/merge.js";
import { readVersion, checkReadPath } from "./publication/read-version.js";
import { validateBatch, type Batch } from "./publication/session.js";

const stampSchema = z.string().regex(/^\d+:\d+:\d+:-?\d+:-?\d+:\d+$/);
const entrySchema = z
  .object({
    path: z.string().min(1).max(1024),
    kind: z.enum(["file", "directory"]),
    identity: z.string().regex(/^\d+:\d+$/),
    stamp: stampSchema,
    mode: z.number().int().min(0).max(0xffff),
    links: z.number().int().positive(),
    object: z
      .string()
      .regex(/^object-[1-9]\d*$/)
      .nullable(),
    objectStamp: stampSchema.nullable(),
    members: z
      .array(
        z
          .string()
          .max(1024)
          .regex(/^[^\0/]+\0[fdlo]$/),
      )
      .max(100000)
      .nullable(),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    source: z.object({ root: z.string(), identity: z.string() }).strict(),
    entries: z.array(entrySchema).min(1).max(10000),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
export type PosixManifest = z.infer<typeof manifestSchema>;

function stamp(info: BigIntStats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`;
}

export async function readPosixManifest(
  control: string,
  id: string,
  source: Source,
) {
  z.uuid().parse(id);
  const storage = await sourceIdentity(control);
  const file = await checkedPath(storage, `${id}.json`);
  const before = await lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > 16n * 1024n * 1024n
  ) {
    throw new PublishError("POSIX_MANIFEST_INVALID");
  }

  const handle = await open(file, "r");
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) {
      throw new PublishError("READ_CHANGED");
    }

    const content = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < content.length) {
      const read = await handle.read(
        content,
        length,
        content.length - length,
        length,
      );
      if (!read.bytesRead) {
        break;
      }

      length += read.bytesRead;
    }

    if (
      length !== Number(before.size) ||
      stamp(await handle.stat({ bigint: true })) !== stamp(before) ||
      stamp(await lstat(file, { bigint: true })) !== stamp(before)
    ) {
      throw new PublishError("READ_CHANGED");
    }

    const manifest = manifestSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          content.subarray(0, length),
        ),
      ),
    );
    const current = await sourceIdentity(source.root);
    if (
      manifest.id !== id ||
      manifest.source.root !== source.root ||
      manifest.source.identity !== source.identity ||
      current.root !== source.root ||
      current.identity !== source.identity
    ) {
      throw new PublishError("SOURCE_REPLACED");
    }

    const paths = new Set<string>();
    for (const entry of manifest.entries) {
      checkReadPath({
        path: entry.path,
        ...(entry.kind === "directory" ? { kind: "directory" } : {}),
      });
      if (
        paths.has(entry.path) ||
        !entry.stamp.startsWith(entry.identity + ":") ||
        !entry.stamp.endsWith(":" + entry.mode) ||
        (entry.object === null) !== (entry.objectStamp === null) ||
        (entry.kind === "file" && entry.members !== null) ||
        (entry.kind === "directory" && entry.object !== null)
      ) {
        throw new PublishError("POSIX_MANIFEST_INVALID");
      }

      paths.add(entry.path);
    }

    if (
      !manifest.entries.some(
        (entry) =>
          entry.path === "." &&
          entry.kind === "directory" &&
          entry.identity === source.identity,
      )
    ) {
      throw new PublishError("SOURCE_REPLACED");
    }

    return manifest;
  } finally {
    await handle.close();
  }
}

async function observedFile(
  source: Source,
  entry: Entry,
  includeContent: boolean,
): Promise<Snapshot> {
  const target = await checkedPath(source, entry.path);
  if (stamp(await lstat(target, { bigint: true })) !== entry.stamp) {
    throw new PublishError("STALE_DEPENDENCY");
  }

  const result = includeContent
    ? await snapshot(source, entry.path)
    : {
        content: null,
        version: await readVersion(source, { path: entry.path }),
        mode: entry.mode & 0o777,
      };
  if (stamp(await lstat(target, { bigint: true })) !== entry.stamp) {
    throw new PublishError("STALE_DEPENDENCY");
  }

  return result;
}

async function readBase(
  source: Source,
  control: Source,
  entry: Entry,
): Promise<Snapshot> {
  if (entry.kind !== "file" || entry.links !== 1) {
    throw new PublishError("FILE_TYPE_OR_LIMIT");
  }

  if (!entry.object) {
    return observedFile(source, entry, true);
  }

  const file = await checkedPath(control, entry.object);
  if (stamp(await lstat(file, { bigint: true })) !== entry.objectStamp) {
    throw new PublishError("POSIX_OBJECT_CHANGED");
  }

  const result = await snapshot(control, entry.object);
  const content = bytes(result);
  if (
    !content ||
    BigInt(content.length) !== BigInt(entry.stamp.split(":")[2]!) ||
    stamp(await lstat(file, { bigint: true })) !== entry.objectStamp
  ) {
    throw new PublishError("POSIX_OBJECT_CHANGED");
  }

  return {
    content: content.toString("base64"),
    mode: entry.mode & 0o777,
    version: digest(`${entry.stamp}:${digest(content)}`),
  };
}

async function capturedReadVersion(
  control: Source,
  entry: Entry,
  signal?: AbortSignal,
) {
  const file = await checkedPath(control, entry.object!);
  const before = await lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    stamp(before) !== entry.objectStamp ||
    before.size !== BigInt(entry.stamp.split(":")[2]!) ||
    before.size > 16n * 1024n * 1024n
  ) {
    throw new PublishError("POSIX_OBJECT_CHANGED");
  }

  const handle = await open(file, "r");
  try {
    if (stamp(await handle.stat({ bigint: true })) !== entry.objectStamp) {
      throw new PublishError("POSIX_OBJECT_CHANGED");
    }

    const buffer = Buffer.alloc(64 * 1024);
    const hash = createHash("sha256");
    let length = 0;
    while (length <= Number(before.size)) {
      signal?.throwIfAborted();
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) + 1 - length),
        length,
      );
      if (!result.bytesRead) {
        break;
      }

      hash.update(buffer.subarray(0, result.bytesRead));
      length += result.bytesRead;
    }

    if (
      length !== Number(before.size) ||
      stamp(await handle.stat({ bigint: true })) !== entry.objectStamp ||
      stamp(
        await lstat(await checkedPath(control, entry.object!), {
          bigint: true,
        }),
      ) !== entry.objectStamp
    ) {
      throw new PublishError("POSIX_OBJECT_CHANGED");
    }

    // 原始 source stamp 与捕获正文组合，编码须与 Publisher snapshotVersion 完全一致。
    return digest(`${entry.stamp}:${hash.digest("hex")}`);
  } finally {
    await handle.close();
  }
}

export async function posixReads(
  source: Source,
  control: string,
  manifest: PosixManifest,
  selected: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Batch["reads"]> {
  const storage = await sourceIdentity(control);
  const reads: Batch["reads"] = [];
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    if (selected.has(entry.path)) {
      continue;
    }

    if (entry.kind === "directory") {
      const read = { path: entry.path, kind: "directory" as const };
      if (entry.members === null) {
        const directory =
          entry.path === "."
            ? source.root
            : await checkedPath(source, entry.path);
        if (stamp(await lstat(directory, { bigint: true })) !== entry.stamp) {
          throw new PublishError("STALE_DEPENDENCY");
        }
      }

      const actual = await readVersion(source, read, signal);
      const version =
        entry.members === null
          ? actual
          : `directory-v1:${digest(`${entry.identity}:${JSON.stringify([...entry.members].sort())}`)}`;
      if (actual !== version) {
        throw new PublishError("STALE_DEPENDENCY");
      }

      reads.push({ ...read, version });
    } else {
      const version = entry.object
        ? await capturedReadVersion(storage, entry, signal)
        : (await observedFile(source, entry, false)).version;
      if (
        (await readVersion(source, { path: entry.path }, signal)) !== version
      ) {
        throw new PublishError("STALE_DEPENDENCY");
      }

      reads.push({ path: entry.path, version });
    }
  }

  return reads;
}

export async function posixBatch(input: {
  source: Source;
  control: string;
  workspace: string;
  sealId: string;
  selected: readonly string[];
  /** 已核验的先前轮次 B；不从主目录重新构造未发布私有修改的基线。 */
  retained?: ReadonlyMap<string, Snapshot>;
  retainedReads?: Batch["reads"];
  signal?: AbortSignal;
}): Promise<Batch> {
  const manifest = await readPosixManifest(
    input.control,
    input.sealId,
    input.source,
  );
  const storage = await sourceIdentity(input.control);
  const view = await sourceIdentity(input.workspace);
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const changes: Batch["changes"] = [];
  const selected = new Set<string>();
  if (!input.selected.length || input.selected.length > 100) {
    throw new PublishError("BATCH_LIMIT");
  }

  for (const file of input.selected) {
    input.signal?.throwIfAborted();
    if (selected.has(file.toLowerCase())) {
      throw new PublishError("DUPLICATE_PATH");
    }

    selected.add(file.toLowerCase());
    const ours = await snapshot(view, file);
    const entry = entries.get(file);
    let base: Snapshot;
    if (input.retained?.has(file)) {
      base = input.retained.get(file)!;
    } else if (entry) {
      base = await readBase(input.source, storage, entry);
    } else {
      const parent = entries.get(path.posix.dirname(file));
      const leaf = path.posix.basename(file);
      if (
        !parent?.members ||
        parent.members.some((member) => member.split("\0")[0] === leaf)
      ) {
        throw new PublishError("POSIX_BASELINE_MISSING");
      }

      base = { content: null, version: "missing", mode: null };
    }

    if (ours.mode !== null && base.mode !== null && ours.mode !== base.mode) {
      throw new PublishError("MODE_CONFLICT");
    }

    if (ours.content !== base.content) {
      changes.push({ path: file, base, ours: ours.content });
    }
  }

  const reads = await posixReads(
    input.source,
    input.control,
    manifest,
    new Set(changes.map((change) => change.path)),
    input.signal,
  );
  for (const read of input.retainedReads ?? []) {
    if (
      (await readVersion(input.source, read, input.signal)) !== read.version
    ) {
      throw new PublishError("STALE_DEPENDENCY");
    }

    const current = reads.find((entry) => entry.path === read.path);
    if (
      current &&
      (current.kind !== read.kind || current.version !== read.version)
    ) {
      throw new PublishError("STALE_DEPENDENCY");
    }

    if (!current) {
      reads.push(read);
    }
  }

  return validateBatch({
    id: randomUUID(),
    source: input.source,
    changes,
    reads,
  });
}

/** 收尾仅保存 B，不读取大型私有生成物正文；不存在须由已观察父目录证明。 */
export async function posixBaseline(
  source: Source,
  control: string,
  manifest: PosixManifest,
  file: string,
): Promise<Snapshot> {
  const entry = manifest.entries.find((entry) => entry.path === file);
  if (entry) {
    return readBase(source, await sourceIdentity(control), entry);
  }

  let current = file;
  while (current !== ".") {
    const parent = manifest.entries.find(
      (entry) => entry.path === path.posix.dirname(current),
    );
    if (
      parent?.members &&
      !parent.members.some(
        (member) => member.split("\0")[0] === path.posix.basename(current),
      )
    ) {
      return { content: null, version: "missing", mode: null };
    }

    current = path.posix.dirname(current);
  }

  throw new PublishError("POSIX_BASELINE_MISSING");
}
