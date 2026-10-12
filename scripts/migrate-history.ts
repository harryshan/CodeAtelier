/**
 * 显式离线历史迁移 CLI；不会启动服务、调用模型或执行历史工具。
 * 1. snapshot 从受保护 raw 副本建立独立恢复副本，再用 SQLite backup API 生成保留 rowid 的一致性快照。
 * 2. convert/verify 接受冻结快照和独立 generation；每个阶段只持有一个操作者锁，失败保留产物与进度。
 * 3. activate 根据绑定原件清单保留旧库并发布整体指针；必须显式声明写入者已停止。
 * 4. metrics/compact 只测量或整理独立目标；CLI 输出阶段和计数，正文不进入日志。
 * Windows AppData 在 MSIX 中可能被重定向：raw 文件捕获和激活使用物理 UNC 路径，SQLite 仅打开本地非 AppData 副本。
 */
import { parseArgs } from "node:util";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import {
  activateGeneration,
  captureFiles,
  convertGeneration,
  verifyGeneration,
} from "../src/sessions/history-generation.js";
import {
  compactOffline,
  storageMetrics,
} from "../src/sessions/storage-maintenance.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    target: { type: "string" },
    "data-dir": { type: "string" },
    file: { type: "string" },
    "writers-stopped": { type: "boolean", default: false },
  },
});
const command = positionals[0];
const required = (value: string | undefined, name: string) => {
  if (!value) {
    throw new Error(`Missing --${name}`);
  }

  return path.resolve(value);
};

const target = values.target ? path.resolve(values.target) : undefined;
if (!values["writers-stopped"] && !["metrics"].includes(command ?? "")) {
  throw new Error("迁移前必须停止全部写入者并传 --writers-stopped。");
}

const lockDirectory =
  target ?? (values.file ? path.dirname(path.resolve(values.file)) : undefined);
if (!lockDirectory) {
  throw new Error("需要 --target 或 --file。");
}

mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
// Lock is outside target so an otherwise empty generation can be initialized safely.
const lockFile = `${lockDirectory}.operator-lock`;
const lock = openSync(lockFile, "wx", 0o600);
writeFileSync(lock, `pid=${process.pid}\n`);
try {
  if (command === "snapshot") {
    const source = required(values.source, "source");
    const output = required(target, "target");
    const originals = captureFiles(source);
    const recovery = path.join(output, "recovery-copy");
    const snapshots = path.join(output, "snapshot");
    if (existsSync(recovery) || existsSync(snapshots)) {
      throw new Error("快照输出目录已存在；保留旧产物并选新目录。");
    }

    mkdirSync(recovery, { mode: 0o700 });
    mkdirSync(snapshots, { mode: 0o700 });
    for (const file of originals) {
      if (!file.name.endsWith("-shm")) {
        copyFileSync(
          path.join(source, file.name),
          path.join(recovery, file.name),
        );
      }
    }

    for (const file of originals.filter((item) =>
      item.name.endsWith(".sqlite"),
    )) {
      const db = new DatabaseSync(path.join(recovery, file.name), {
        readOnly: true,
      });
      try {
        await backup(db, path.join(snapshots, file.name));
      } finally {
        db.close();
      }
    }

    const provenance = {
      originals,
      snapshots: captureFiles(snapshots).filter((file) =>
        file.name.endsWith(".sqlite"),
      ),
    };
    writeFileSync(
      path.join(snapshots, "snapshot-provenance.json"),
      JSON.stringify(provenance, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
      `snapshot complete: ${provenance.snapshots.length} shards\n`,
    );
  } else if (command === "convert") {
    let last = performance.now();
    convertGeneration(
      required(values.source, "source"),
      required(target, "target"),
      (stage, cursor) => {
        if (performance.now() - last > 5000) {
          process.stdout.write(`conversion ${stage.split(":")[0]} ${cursor}\n`);
          last = performance.now();
        }
      },
    );
    process.stdout.write("conversion complete; activation remains blocked\n");
  } else if (command === "verify") {
    const reports = verifyGeneration(
      required(values.source, "source"),
      required(target, "target"),
    );
    process.stdout.write(`verification complete: ${reports.length} shards\n`);
  } else if (command === "activate") {
    const directory = required(values["data-dir"], "data-dir");
    const destination = required(target, "target");
    const manifest = JSON.parse(
      readFileSync(path.join(destination, "generation.json"), "utf8"),
    );
    activateGeneration(directory, destination, manifest.originals);
    process.stdout.write("activation complete; originals retained\n");
  } else if (command === "metrics" || command === "compact") {
    const file = required(values.file, "file");
    const metrics =
      command === "compact" ? compactOffline(file) : storageMetrics(file);
    for (const [key, value] of Object.entries(metrics)) {
      process.stdout.write(`${key}: ${value}\n`);
    }
  } else {
    throw new Error(
      "使用 snapshot、convert、verify、activate、metrics 或 compact 子命令。",
    );
  }
} finally {
  closeSync(lock);
  unlinkSync(lockFile);
}
