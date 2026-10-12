/**
 * 离线历史 generation 的清单、全量验证和整体激活协议，由迁移 CLI 和生产启动调用。
 * 1. convertGeneration 绑定冻结源集合和摘要，逐片断点续跑；未知或变化的输入拒绝继续。
 * 2. verifyGeneration 独立核对所有分片及全局 ID，再记录验证后的文件摘要与空间指标。
 * 3. activateGeneration 先写启动门禁和可恢复日志，保留全部原件，再安装旧入口阻断目录并原子发布指针。
 * 4. resolveHistoryFile 只解析清单；业务启动前持久标记 business-started，此后禁止迁移工具自动回退。
 * 文件系统操作要求服务和其他写入者已停止。标记不是对不合作外部程序的 OS 隔离；Windows 冻结工具另用文件共享锁捕获原件。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { fingerprint, migrateShard, verifyAndSealShard } from "./migration.js";
import {
  storageMetrics,
  assertSpaceAcceptance,
} from "./storage-maintenance.js";

const shardName = /^history(?:-\d{6})?\.sqlite$/;
const rawName = /^history(?:-\d{6})?\.sqlite(?:-wal|-shm)?$/;
const manifestName = "generation.json";
const gateName = "history-migration.json";
const pointerName = "history-active.json";
const fileSchema = z.object({
  name: z.string().regex(rawName),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});
const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  schema: z.literal(11),
  replay: z.literal(3),
  state: z.enum(["prepared", "verified", "activated"]),
  sources: z.array(fileSchema),
  originals: z.array(fileSchema),
  targets: z.array(fileSchema).optional(),
});
export type CapturedFile = z.infer<typeof fileSchema>;
type Manifest = z.infer<typeof manifestSchema>;

function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, JSON.stringify(value, null, 2));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }

  renameSync(temporary, file);
}

function readManifest(directory: string) {
  return manifestSchema.parse(
    JSON.parse(readFileSync(path.join(directory, manifestName), "utf8")),
  );
}

export function generationSourceHash(directory: string, filename: string) {
  if (!existsSync(path.join(directory, manifestName))) {
    return undefined;
  }

  const manifest = readManifest(directory);
  const shard = manifest.sources.find((item) => item.name === filename);
  if (shard) {
    return shard.sha256;
  }

  const sequence = (name: string) =>
    Number(/-(\d{6})\.sqlite$/.exec(name)?.[1] ?? 0);
  if (
    sequence(filename) <=
    Math.max(...manifest.sources.map((item) => sequence(item.name)))
  ) {
    throw new Error("活动 generation 中发现未知历史分片。");
  }

  return null;
}

export function captureFiles(directory: string): CapturedFile[] {
  return readdirSync(directory)
    .filter(
      (name) =>
        rawName.test(name) && statSync(path.join(directory, name)).isFile(),
    )
    .sort()
    .map((name) => ({
      name,
      bytes: statSync(path.join(directory, name)).size,
      sha256: fingerprint(path.join(directory, name)),
    }));
}

function frozenFiles(directory: string) {
  const files = captureFiles(directory);
  if (
    !files.some((file) => file.name === "history.sqlite") ||
    files.some((file) => file.name.endsWith("-wal") && file.bytes > 0)
  ) {
    throw new Error("输入必须包含完整冻结分片且没有未合并 WAL。");
  }

  return files.filter((file) => shardName.test(file.name));
}

function assertSameFiles(actual: CapturedFile[], expected: CapturedFile[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("文件集合、大小或摘要已变化，停止迁移。");
  }
}

export function convertGeneration(
  source: string,
  target: string,
  progress?: (stage: string, cursor: number) => void,
) {
  if (path.resolve(source) === path.resolve(target)) {
    throw new Error("源和目标必须独立。");
  }

  const sources = frozenFiles(source);
  const provenanceFile = path.join(source, "snapshot-provenance.json");
  let originals = sources;
  if (existsSync(provenanceFile)) {
    const provenance = z
      .object({
        originals: z.array(fileSchema),
        snapshots: z.array(fileSchema),
      })
      .parse(JSON.parse(readFileSync(provenanceFile, "utf8")));
    assertSameFiles(sources, provenance.snapshots);
    originals = provenance.originals;
  }

  mkdirSync(target, { recursive: true, mode: 0o700 });
  const disk = statfsSync(target);
  if (
    disk.bavail * disk.bsize <
    sources.reduce((sum, file) => sum + file.bytes, 0) * 2 + 256 * 1024 * 1024
  ) {
    throw new Error("转换目标磁盘预检空间不足，保留原件和已有进度。");
  }

  const manifestFile = path.join(target, manifestName);
  let manifest: Manifest;
  if (existsSync(manifestFile)) {
    manifest = readManifest(target);
    assertSameFiles(sources, manifest.sources);
    assertSameFiles(originals, manifest.originals);
    if (manifest.state !== "prepared") {
      throw new Error("已验证或启用的 generation 不允许再次转换。");
    }
  } else {
    if (readdirSync(target).length > 0) {
      throw new Error("新 generation 目录必须为空。");
    }

    manifest = {
      version: 1,
      id: randomUUID(),
      schema: 11,
      replay: 3,
      state: "prepared",
      sources,
      originals,
    };
    atomicJson(manifestFile, manifest);
  }

  for (const file of sources) {
    migrateShard(path.join(source, file.name), path.join(target, file.name), {
      afterCommit: progress,
    });
  }

  return manifest;
}

export function verifyGeneration(source: string, target: string) {
  const manifest = readManifest(target);
  if (
    manifest.state === "activated" ||
    existsSync(path.join(target, "business-started"))
  ) {
    throw new Error("业务 generation 不能重新迁移验证。");
  }

  assertSameFiles(frozenFiles(source), manifest.sources);
  const identities = {
    sessions: new Set<string>(),
    tasks: new Set<string>(),
    events: new Set<string>(),
  };
  const reports = [];
  for (const file of manifest.sources) {
    const targetFile = path.join(target, file.name);
    const report = verifyAndSealShard(path.join(source, file.name), targetFile);
    const metrics = storageMetrics(targetFile);
    assertSpaceAcceptance(metrics);
    const db = new DatabaseSync(targetFile, { readOnly: true });
    try {
      for (const table of ["sessions", "tasks", "events"] as const) {
        for (const row of db.prepare(`SELECT id FROM ${table}`).iterate()) {
          const id = String(row.id);
          if (identities[table].has(id)) {
            throw new Error("跨分片 ID 冲突，禁止激活。");
          }

          identities[table].add(id);
        }
      }
    } finally {
      db.close();
    }

    reports.push({ name: file.name, ...report, metrics });
  }

  const targets = captureFiles(target).filter((file) =>
    shardName.test(file.name),
  );
  if (
    targets.map((file) => file.name).join() !==
    manifest.sources.map((file) => file.name).join()
  ) {
    throw new Error("目标分片集合不完整。");
  }

  atomicJson(path.join(target, "verification.json"), {
    generationId: manifest.id,
    reports,
  });
  atomicJson(path.join(target, manifestName), {
    ...manifest,
    targets,
    state: "verified",
  });

  return reports;
}

export function activateGeneration(
  directory: string,
  target: string,
  originals: CapturedFile[],
  afterMove?: () => void,
) {
  target = path.resolve(target);
  const manifest = readManifest(target);
  if (existsSync(path.join(target, "business-started"))) {
    throw new Error("新库已经开始业务，禁止自动重新激活或回退。");
  }

  if (
    !manifest.targets ||
    !["verified", "activated"].includes(manifest.state)
  ) {
    throw new Error("整个 generation 尚未验证。");
  }

  assertSameFiles(
    captureFiles(target).filter((file) => shardName.test(file.name)),
    manifest.targets,
  );
  if (
    captureFiles(target).some(
      (file) => file.name.endsWith("-wal") && file.bytes > 0,
    )
  ) {
    throw new Error("验证后目标出现 WAL，必须重新全量验证。");
  }

  assertSameFiles(originals, manifest.originals);
  if (
    !originals.length ||
    !originals.some((file) => file.name === "history.sqlite")
  ) {
    throw new Error("缺少原件清单。");
  }

  const gateFile = path.join(directory, gateName);
  const archive = path.join(directory, `history-before-${manifest.id}`);
  const journal = {
    version: 1,
    generationId: manifest.id,
    target,
    originals,
    archive,
  };
  if (existsSync(gateFile)) {
    if (
      JSON.stringify(JSON.parse(readFileSync(gateFile, "utf8"))) !==
      JSON.stringify(journal)
    ) {
      throw new Error("另一个迁移操作占用数据目录。");
    }
  } else {
    if (existsSync(path.join(directory, pointerName))) {
      throw new Error("已有活动指针，必须核对旧激活状态。");
    }

    assertSameFiles(captureFiles(directory), originals);
    // wx ensures only one operator establishes the startup gate.
    const gate = openSync(gateFile, "wx", 0o600);
    try {
      writeFileSync(gate, JSON.stringify(journal));
      fsyncSync(gate);
    } finally {
      closeSync(gate);
    }
  }

  mkdirSync(archive, { recursive: true, mode: 0o700 });
  for (const file of originals) {
    fileSchema.parse(file);
    const original = path.join(directory, file.name);
    const saved = path.join(archive, file.name);
    const alreadySaved = existsSync(saved);
    const current = alreadySaved ? saved : original;
    if (
      !existsSync(current) ||
      fingerprint(current) !== file.sha256.toLowerCase()
    ) {
      throw new Error("原件摘要不符，保留激活门禁并停止。");
    }

    if (!alreadySaved) {
      renameSync(original, saved);
      afterMove?.();
    } else if (existsSync(original) && statSync(original).isFile()) {
      throw new Error("原路径存在意外新文件，禁止覆盖。");
    }
  }

  // Old binaries use this exact default filename. A directory makes SQLite refuse to open it.
  mkdirSync(path.join(directory, "history.sqlite"), {
    recursive: true,
    mode: 0o700,
  });
  atomicJson(path.join(target, manifestName), {
    ...manifest,
    state: "activated",
  });
  atomicJson(path.join(directory, pointerName), {
    version: 1,
    generationId: manifest.id,
    directory: target,
  });
  unlinkSync(gateFile);

  return { generationId: manifest.id, target, archive };
}

/** Only filesystem metadata is read here; SQLite preflight stays in the Store Worker. */
export function resolveHistoryFile(file: string, markBusiness = false) {
  const root = path.dirname(file);
  if (existsSync(path.join(root, gateName))) {
    throw new Error("历史迁移尚未完成激活，禁止启动。");
  }

  const pointer = path.join(root, pointerName);
  let directory = root;
  let expectedId: string | undefined;
  if (existsSync(pointer)) {
    const value = z
      .object({
        version: z.literal(1),
        generationId: z.string().uuid(),
        directory: z.string().min(1),
      })
      .parse(JSON.parse(readFileSync(pointer, "utf8")));
    if (!path.isAbsolute(value.directory)) {
      throw new Error("活动 generation 路径必须绝对定位。");
    }

    directory = value.directory;
    expectedId = value.generationId;
  }

  if (existsSync(path.join(directory, manifestName)) || expectedId) {
    const manifest = readManifest(directory);
    if (
      manifest.state !== "activated" ||
      (expectedId && manifest.id !== expectedId)
    ) {
      throw new Error("generation 未整体激活或身份不一致。");
    }

    for (const shard of manifest.sources) {
      if (
        !shardName.test(shard.name) ||
        !existsSync(path.join(directory, shard.name))
      ) {
        throw new Error("活动 generation 缺少分片。");
      }
    }

    if (markBusiness && !existsSync(path.join(directory, "business-started"))) {
      const handle = openSync(
        path.join(directory, "business-started"),
        "wx",
        0o600,
      );
      try {
        writeFileSync(handle, manifest.id);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    }
  }

  return path.join(directory, path.basename(file));
}
