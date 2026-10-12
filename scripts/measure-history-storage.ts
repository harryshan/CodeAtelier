/**
 * 手动存储基准，不属于模型 Evaluation，也不连接真实用户历史。
 * 1. 在全新输出目录创建 1/2/4 个合成任务，以相同 16KiB 事件、增量上下文和 Replay 输入执行固定负载。
 * 2. 基线可加载指定历史 Store 模块；目标使用生产 AsyncStore，分别测量写延迟、历史浏览和事件循环。
 * 3. 保存主库/WAL 峰值、RSS、逻辑正文和 p50/p95/p99，结束后检查 SQLite 完整性；不删除基准产物。
 * 4. 输出 JSON 是手动基准报告而非运行期日志；仅含合成负载配置和数值。
 */
import { parseArgs } from "node:util";
import { mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { AsyncStore } from "../src/sessions/async-store.js";
import { storageMetrics } from "../src/sessions/storage-maintenance.js";
import { replaySettings } from "../src/sessions/replay-case.js";
import { settingsSchema } from "../src/config/settings.js";

const { values } = parseArgs({
  options: { output: { type: "string" }, baseline: { type: "string" } },
});
if (!values.output) {
  throw new Error("需要全新 --output 目录。");
}

const output = path.resolve(values.output);
if (existsSync(output)) {
  throw new Error("输出目录已存在，不能覆盖。");
}

mkdirSync(output, { recursive: true });
const Baseline = values.baseline
  ? (await import(pathToFileURL(path.resolve(values.baseline)).href)).Store
  : undefined;
const reports = [];
const defaultSettings = settingsSchema.parse({
  baseUrl: "http://127.0.0.1:9999/v1",
  model: "synthetic",
  maxSteps: 40,
  requestTimeoutMs: 300000,
  idleTimeoutMs: 30000,
  contextChars: 120000,
  outputChars: 12000,
  logLevel: "info",
});
for (const concurrency of [1, 2, 4]) {
  const file = path.join(output, `workload-${concurrency}`, "history.sqlite");
  mkdirSync(path.dirname(file));
  const store = Baseline ? new Baseline(file) : await AsyncStore.open(file);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const writeMs: number[] = [];
  const readMs: number[] = [];
  let peakWal = 0;
  let peakRss = 0;
  let logicalBytes = 0;
  const sample = () => {
    peakWal = Math.max(
      peakWal,
      existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0,
    );
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  const timer = setInterval(sample, 20);
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async (_, actor) => {
        const session = await store.createAsync(output, `synthetic-${actor}`);
        const { task } = await store.startTaskAsync(
          session.id,
          "synthetic workload",
          false,
        );
        await store.replayAsync(task.id, "create", null, {
          schemaVersion: 1,
          capturedAt: task.createdAt,
          platform: "win32",
          settings: replaySettings(defaultSettings),
        });
        const input = [];
        let parentId: string | null = null;
        for (let index = 0; index < 512; index++) {
          const data = { text: `${actor}:${index}:` + "x".repeat(16384) };
          logicalBytes += Buffer.byteLength(JSON.stringify(data));
          const started = performance.now();
          await store.eventAsync(session.id, task.id, "notice", data);
          writeMs.push(performance.now() - started);
          if (index % 8 === 0) {
            input.push({
              role: "user",
              content: `round-${index}:` + "y".repeat(4096),
            });
            await store.appendContextAsync(session.id, [input.at(-1)]);
            const id = `request-${index}`;
            await store.replayAsync(task.id, "modelStart", id, {
              id,
              purpose: "task",
              input,
              instructions: "synthetic",
              tools: [],
              options: {},
            });
            await store.replayAsync(task.id, "modelFinish", id, {
              response: { output: [], text: "done" },
            });
          }

          if (index % 64 === 63) {
            const id = `snapshot-${actor}-${index}`;
            await store.compactContextAsync(
              session.id,
              {
                version: 1,
                id,
                sessionId: session.id,
                parentId,
                sourceHash: "0".repeat(64),
                model: "synthetic",
                createdAt: new Date().toISOString(),
                beforeChars: 1,
                afterChars: 1,
                cut: input.length,
                source: [...input],
                summaries: [],
                ledger: [],
                stage: "fallback",
              },
              input.slice(-8),
            );
            parentId = id;
            const readStart = performance.now();
            if (Baseline) {
              await store.eventsAsync(session.id);
            } else {
              await store.snapshotPage(session.id);
            }

            readMs.push(performance.now() - readStart);
          }

          sample();
        }
      }),
    );
    await store.drain();
    sample();
  } finally {
    clearInterval(timer);
    delay.disable();
    await store.closeAsync();
  }

  const percentile = (items: number[], fraction: number) =>
    [...items].sort((a, b) => a - b)[
      Math.min(items.length - 1, Math.floor(items.length * fraction))
    ] ?? 0;
  const metrics = storageMetrics(file);
  const db = new DatabaseSync(file, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").all();
  db.close();
  if (integrity.some((row) => row.integrity_check !== "ok")) {
    throw new Error("合成负载后数据库完整性失败。");
  }

  reports.push({
    concurrency,
    eventsPerTask: 512,
    eventTextChars: 16384,
    logicalBytes,
    peakWal,
    peakRss,
    writeMs: {
      p50: percentile(writeMs, 0.5),
      p95: percentile(writeMs, 0.95),
      p99: percentile(writeMs, 0.99),
    },
    browseMs: {
      p50: percentile(readMs, 0.5),
      p95: percentile(readMs, 0.95),
      p99: percentile(readMs, 0.99),
    },
    eventLoopMs: {
      p50: delay.percentile(50) / 1e6,
      p95: delay.percentile(95) / 1e6,
      p99: delay.percentile(99) / 1e6,
    },
    metrics,
  });
  process.stdout.write(`storage workload ${concurrency} complete\n`);
}

writeFileSync(
  path.join(output, "report.json"),
  JSON.stringify(
    { baseline: Boolean(Baseline), node: process.version, reports },
    null,
    2,
  ),
  { flag: "wx" },
);
