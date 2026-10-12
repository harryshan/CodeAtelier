/**
 * SQLite 空间测量和离线整理，不由业务请求自动 VACUUM，不删除源库或 WAL。
 * 1. storageMetrics 用只读连接报告主库、整页空闲和 dbstat 页内利用率；不支持 dbstat 时明确报错。
 * 2. assertSpaceAcceptance 应用冻结的新库验收阈值，小库页开销单独豁免；不承诺永久零碎片。
 * 3. compactOffline 只针对未开始业务的独立目标，先撤销 verified 标记，再整理并要求重新全量验证。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync, statfsSync } from "node:fs";
import path from "node:path";

export const SPACE_POLICY = {
  maxFreeRatio: 0.05,
  minPayloadRatio: 0.7,
  minMeasuredBytes: 16 * 1024 * 1024,
  autoCheckpointPages: 1000,
  maxBenchmarkWalBytes: 64 * 1024 * 1024,
} as const;

export function storageMetrics(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const pages = Number(db.prepare("PRAGMA page_count").get()!.page_count);
    const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    const free = Number(
      db.prepare("PRAGMA freelist_count").get()!.freelist_count,
    );
    const layout = db
      .prepare(
        "SELECT sum(pgsize) AS allocated,sum(payload) AS payload,sum(unused) AS unused,count(*) AS pages FROM dbstat",
      )
      .get()!;

    return {
      bytes: statSync(file).size,
      pages,
      pageSize,
      freePages: free,
      freeBytes: free * pageSize,
      allocatedBytes: Number(layout.allocated),
      payloadBytes: Number(layout.payload),
      unusedBytes: Number(layout.unused),
      freeRatio: pages ? free / pages : 0,
      payloadRatio: Number(layout.payload) / Number(layout.allocated),
      walBytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0,
    };
  } finally {
    db.close();
  }
}

export function assertSpaceAcceptance(
  metrics: ReturnType<typeof storageMetrics>,
) {
  if (
    metrics.freeRatio > SPACE_POLICY.maxFreeRatio ||
    (metrics.bytes >= SPACE_POLICY.minMeasuredBytes &&
      metrics.payloadRatio < SPACE_POLICY.minPayloadRatio)
  ) {
    throw new Error("目标未通过空间验收，需要离线整理或检查后重新验证。");
  }
}

export function compactOffline(file: string) {
  if (existsSync(path.join(path.dirname(file), "business-started"))) {
    throw new Error("活动 generation 必须另行停机备份，不能当迁移目标整理。");
  }

  const disk = statfsSync(path.dirname(file));
  if (disk.bavail * disk.bsize < statSync(file).size * 2 + 256 * 1024 * 1024) {
    throw new Error("离线整理磁盘预检空间不足。");
  }

  const db = new DatabaseSync(file, { timeout: 1000 });
  try {
    db.prepare(
      "UPDATE migration_identity SET state='converted' WHERE singleton=1",
    ).run();
    const check = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (check?.busy) {
      throw new Error("目标存在读写者，不能整理。");
    }

    db.exec("PRAGMA synchronous=FULL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }

  return storageMetrics(file);
}
