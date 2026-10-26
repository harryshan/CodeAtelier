/**
 * Linux Local 正常跨轮状态：独立于可重建的 lower 缓存保存未发布 B 与保守依赖。
 * 1. capturePosixRound 只遍历私有 upper，用当前原生观察或先前 B 记录私有普通文件；
 *    新生成物保存 missing 基线，不读取其正文。目录/不支持对象不作为源码发布。
 * 2. validatePosixRound 严格验证来源、路径、正文及总预算；状态通过既有 durableJson 保存。
 * 3. acknowledgePosixRound 只接受 Publisher complete 日志，复核来源结果与所选私有内容，
 *    返回剔除已发布 B 的下一状态和待移除覆盖；不修改 upper、不重放来源写入。
 * 4. posixRoundInputs 将旧 B 和保守依赖交给下一轮批次，来源变化仍须重新校验。
 * 调用方必须排空 Runtime、持有独占生命周期，普通卸载后移除已确认覆盖，再保存状态。
 * 本模块不证明卸载/崩溃恢复；尚未注册产品 backend，观测例外见 POSIX Local 设计。
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  checkRelative,
  digest,
  snapshot,
  sourceIdentity,
  type Snapshot,
  type Source,
} from "./publication/files.js";
import { PublishError } from "./publication/merge.js";
import { readSetSchema } from "./publication/read-set.js";
import { readVersion } from "./publication/read-version.js";
import { Publisher } from "./publication/publisher.js";
import type { Batch } from "./publication/session.js";
import { posixBaseline, posixReads, readPosixManifest } from "./posix-batch.js";

const baseSchema = z
  .object({
    content: z.string().max(2796204).nullable(),
    version: z.string().min(1).max(1024),
    mode: z.number().int().min(0).max(0o777).nullable(),
  })
  .strict();
const roundSchema = z
  .object({
    version: z.literal(1),
    source: z.object({ root: z.string(), identity: z.string() }).strict(),
    epoch: z.number().int().min(0).max(1000000000),
    baselines: z
      .array(z.object({ path: z.string(), base: baseSchema }).strict())
      .max(10000),
    reads: readSetSchema,
  })
  .strict();
export type PosixRound = z.infer<typeof roundSchema>;

export function validatePosixRound(value: unknown, source: Source): PosixRound {
  const state = roundSchema.parse(value);
  if (
    state.source.root !== source.root ||
    state.source.identity !== source.identity
  ) {
    throw new PublishError("SOURCE_REPLACED");
  }

  const paths = new Set<string>();
  let size = 0;
  for (const entry of state.baselines) {
    checkRelative(entry.path);
    if (paths.has(entry.path)) {
      throw new PublishError("DUPLICATE_PATH");
    }

    paths.add(entry.path);
    if (entry.base.content !== null) {
      const content = Buffer.from(entry.base.content, "base64");
      size += content.length;
      if (
        content.length > 2 * 1024 * 1024 ||
        content.toString("base64") !== entry.base.content
      ) {
        throw new PublishError("FILE_LIMIT");
      }
    }
  }

  if (size > 16 * 1024 * 1024) {
    throw new PublishError("BATCH_LIMIT");
  }

  return state;
}

async function upperFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let visited = 0;
  const walk = async (relative: string) => {
    const entries = await readdir(path.join(directory, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (++visited > 10000) {
        throw new PublishError("READ_LIMIT");
      }

      const file = relative ? `${relative}/${entry.name}` : entry.name;
      checkRelative(file);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile() || entry.isCharacterDevice()) {
        // Kernel whiteouts may be character device 0:0. Other devices refuse.
        const info = await lstat(path.join(directory, file));
        if (entry.isCharacterDevice() && info.rdev !== 0) {
          throw new PublishError("FILE_TYPE_OR_LIMIT");
        }

        files.push(file);
      } else {
        throw new PublishError("FILE_TYPE_OR_LIMIT");
      }
    }
  };

  await walk("");

  return files;
}

export async function capturePosixRound(input: {
  source: Source;
  control: string;
  sealId: string;
  upper: string;
  previous?: PosixRound;
}): Promise<PosixRound> {
  const previous = input.previous
    ? validatePosixRound(input.previous, input.source)
    : undefined;
  const manifest = await readPosixManifest(
    input.control,
    input.sealId,
    input.source,
  );
  const originals = new Map(
    previous?.baselines.map((entry) => [entry.path, entry.base]),
  );
  const paths = await upperFiles((await sourceIdentity(input.upper)).root);
  const baselines: PosixRound["baselines"] = [];
  for (const file of paths) {
    baselines.push({
      path: file,
      base:
        originals.get(file) ??
        (await posixBaseline(input.source, input.control, manifest, file)),
    });
  }

  const reads = await posixReads(
    input.source,
    input.control,
    manifest,
    new Set(paths),
  );
  for (const read of previous?.reads ?? []) {
    if ((await readVersion(input.source, read)) !== read.version) {
      throw new PublishError("STALE_DEPENDENCY");
    }

    const existing = reads.find((entry) => entry.path === read.path);
    if (
      existing &&
      (existing.version !== read.version || existing.kind !== read.kind)
    ) {
      throw new PublishError("STALE_DEPENDENCY");
    }

    if (!existing) {
      reads.push(read);
    }
  }

  return validatePosixRound(
    {
      version: 1,
      source: input.source,
      epoch: (previous?.epoch ?? -1) + 1,
      baselines,
      reads,
    },
    input.source,
  );
}

export function posixRoundInputs(
  input: PosixRound,
  source: Source,
  selected: readonly string[],
) {
  const state = validatePosixRound(input, source);
  const retained = new Map<string, Snapshot>(
    state.baselines.map((entry) => [entry.path, entry.base]),
  );
  const retainedReads = [...state.reads];
  for (const entry of state.baselines) {
    if (
      !selected.includes(entry.path) &&
      entry.base.content !== null &&
      !retainedReads.some((read) => read.path === entry.path)
    ) {
      retainedReads.push({ path: entry.path, version: entry.base.version });
    }
  }

  return { retained, retainedReads };
}

export async function acknowledgePosixRound(input: {
  state: PosixRound;
  batch: Batch;
  publications: string;
  workspace: string;
}): Promise<{
  state: PosixRound;
  remove: { path: string; contentDigest: string | null }[];
}> {
  const state = validatePosixRound(input.state, input.batch.source);
  const { journal } = await new Publisher(input.publications).recordedJournal(
    input.batch.source,
    input.batch.id,
  );
  if (
    journal.state !== "complete" ||
    JSON.stringify(journal.batch) !== JSON.stringify(input.batch)
  ) {
    throw new PublishError("PUBLICATION_NOT_COMPLETE");
  }

  const view = await sourceIdentity(input.workspace);
  const remove: { path: string; contentDigest: string | null }[] = [];
  const reads = [...state.reads];
  for (const change of input.batch.changes) {
    const base = state.baselines.find(
      (entry) => entry.path === change.path,
    )?.base;
    const published = journal.entries.find(
      (entry) => entry.path === change.path,
    );
    const ours = await snapshot(view, change.path);
    const current = await snapshot(input.batch.source, change.path);
    if (
      !base ||
      base.version !== change.base.version ||
      ours.content !== change.ours ||
      current.content !== published?.after
    ) {
      throw new PublishError("PRIVATE_REFRESH_CHANGED");
    }

    remove.push({
      path: change.path,
      contentDigest:
        ours.content === null
          ? null
          : digest(Buffer.from(ours.content, "base64")),
    });
    const index = reads.findIndex((entry) => entry.path === change.path);
    const read = { path: change.path, version: current.version };
    if (index < 0) {
      reads.push(read);
    } else {
      reads[index] = read;
    }
  }

  const baselines = state.baselines.filter(
    (entry) => !remove.some((item) => item.path === entry.path),
  );
  // Directory membership changes require a future explicit rebase protocol;
  // never replace an old digest with today's directory contents implicitly.
  for (const read of reads) {
    if ((await readVersion(state.source, read)) !== read.version) {
      throw new PublishError("STALE_DEPENDENCY");
    }
  }

  return {
    state: validatePosixRound(
      { ...state, baselines, reads: baselines.length ? reads : [] },
      state.source,
    ),
    remove,
  };
}
