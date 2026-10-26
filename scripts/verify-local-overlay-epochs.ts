/**
 * 手动验证 Local v6 的失败/取消续轮及跨轮私有读依赖，使用真实 WinFsp 与宿主命令。
 * 1. mount/rows/request 只操作独占 .local 夹具；冻结后生成绑定当前 epoch/seal 的续轮请求。
 * 2. 命令非零退出后保留修改，幂等推进观察周期；重新读取来源后可发布无关的新修改。
 * 3. 真实取消并排空进程，再以独立清理周期续轮；两次派生私有结果仍继承过期来源依赖。
 * 4. 已执行请求跨重挂载重试不推进两次，未执行旧 seal 拒绝；异常夹具保留而不强行恢复。
 * 5. 输出通过摘要并关闭全部 helper；不安装驱动、不碰实际服务/用户项目，不进入 Evaluation。
 * 本实验是宿主进程生命周期，不能代替产品任务/Sandbox/历史上下文的完整一致性验收。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../src/logging/logger.js";
import { executeProcess } from "../src/tools/process.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
  type OverlayEpochTransition,
} from "../src/local-overlays/winfsp-manager.js";
import { nativeBatch } from "../src/local-overlays/publication/native-batch.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-epochs-"));
const source = path.join(root, "source");
await mkdir(source);
await writeFile(path.join(source, "dep.txt"), "old dependency\n");
await writeFile(path.join(source, "refresh.txt"), "old live\n");
const identity = await sourceIdentity(source);
const log = createLogger(root, "info");
const publisher = new Publisher(path.join(root, "publisher"), log);
const managers: OverlayManager[] = [];
const refused = new Set<OverlayManager>();
const id = randomUUID();
const workspace = overlayWorkspace(overlayNamespace(root), id);
const control = path.join(root, "control");

async function mount(create: boolean) {
  const manager = new OverlayManager(root, log);
  managers.push(manager);
  await manager.start(
    id,
    source,
    control,
    workspace,
    create,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );

  return manager;
}

function rows(sql: string) {
  const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function request(): OverlayEpochTransition {
  const state = rows("SELECT epoch,seal FROM local_state")[0]!;
  assert.equal(typeof state.epoch, "number");
  assert.equal(typeof state.seal, "string");

  return {
    requestId: randomUUID(),
    epoch: state.epoch as number,
    seal: state.seal as string,
  };
}

const failureCommand = `const fs = require('node:fs');
const text = fs.readFileSync('dep.txt', 'utf8');
fs.readFileSync('refresh.txt', 'utf8');
fs.writeFileSync('retained.txt', text + 'private result');
process.exit(7);`;
const cancelCommand = `const fs = require('node:fs');
fs.renameSync('retained.txt', 'renamed.txt');
fs.writeFileSync('derived.txt', fs.readFileSync('renamed.txt', 'utf8') + '\\nderived');
process.stdout.write('CANCEL_READY');
setInterval(() => {}, 1000);`;

try {
  const failed = await mount(true);
  const result = await executeProcess(
    process.execPath,
    ["-e", failureCommand],
    workspace,
    AbortSignal.timeout(10_000),
    10_000,
    8192,
    () => {},
  );
  assert.equal(result.exitCode, 7);
  let initial!: OverlayEpochTransition;
  await failed.withFrozen(
    id,
    async (_verify, _acknowledge, _signal, _collect, nextEpoch) => {
      initial = request();
      const edits = rows("SELECT * FROM baselines ORDER BY path");
      const reads = rows("SELECT * FROM observations ORDER BY epoch,path");
      await nextEpoch(initial);
      await nextEpoch(initial);
      assert.equal(rows("SELECT epoch FROM local_state")[0]?.epoch, 1);
      assert.deepEqual(rows("SELECT * FROM baselines ORDER BY path"), edits);
      assert.deepEqual(
        rows("SELECT * FROM observations ORDER BY epoch,path"),
        reads,
      );
    },
  );
  await assert.rejects(readFile(path.join(source, "retained.txt")), {
    code: "ENOENT",
  });
  await writeFile(path.join(source, "dep.txt"), "new dependency\n");
  await writeFile(path.join(source, "refresh.txt"), "new live\n");

  const fresh = await mount(false);
  assert.equal(
    await readFile(path.join(workspace, "refresh.txt"), "utf8"),
    "new live\n",
  );
  await writeFile(path.join(workspace, "refresh.txt"), "new live edited\n");
  await fresh.withFrozen(
    id,
    async (verify, acknowledge, signal, _collect, nextEpoch) => {
      await nextEpoch(initial);
      assert.equal(rows("SELECT epoch FROM local_state")[0]?.epoch, 1);
      await assert.rejects(
        nativeBatch(identity, control, ["retained.txt"], verify),
        /STALE_DEPENDENCY/,
      );
      const batch = await nativeBatch(
        identity,
        control,
        ["refresh.txt"],
        verify,
      );
      await publisher.publish(batch, {
        nativeWindows: true,
        signal,
        validate: async (files) =>
          assert.equal(
            files.get("refresh.txt")?.toString(),
            "new live edited\n",
          ),
        refresh: {
          request: batch.acknowledgement,
          checkpoint: batch.checkpoint,
          acknowledge,
        },
      });
    },
  );

  const cancelled = await mount(false);
  const cancellation = new AbortController();
  let output = "";
  let pid = 0;
  await assert.rejects(
    executeProcess(
      process.execPath,
      ["-e", cancelCommand],
      workspace,
      cancellation.signal,
      10_000,
      8192,
      (chunk) => {
        output += chunk;
        if (output.includes("CANCEL_READY")) {
          cancellation.abort();
        }
      },
      {},
      (started) => {
        pid = started;
      },
    ),
    /取消/,
  );
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(cancellation.signal.aborted, true);
  await cancelled.withFrozen(
    id,
    async (_verify, _acknowledge, signal, _collect, nextEpoch) => {
      assert.equal(signal.aborted, false);
      await nextEpoch(request());
    },
  );
  await assert.rejects(readFile(path.join(source, "derived.txt")), {
    code: "ENOENT",
  });

  const inherited = await mount(false);
  const derived = await readFile(path.join(workspace, "derived.txt"), "utf8");
  assert.ok(derived.includes("old dependency"));
  await writeFile(path.join(workspace, "twice.txt"), derived + " twice");
  await inherited.withFrozen(
    id,
    async (verify, _acknowledge, _signal, collect, nextEpoch) => {
      assert.deepEqual(
        rows("SELECT * FROM epoch_links ORDER BY epoch,dependency").map(
          (row) => ({ ...row }),
        ),
        [
          { epoch: 2, dependency: 0 },
          { epoch: 3, dependency: 2 },
        ],
      );
      await assert.rejects(
        nativeBatch(identity, control, ["twice.txt"], verify),
        /STALE_DEPENDENCY/,
      );
      await collect();
      await assert.rejects(
        nativeBatch(identity, control, ["twice.txt"], verify),
        /STALE_DEPENDENCY/,
      );
      await nextEpoch(request());
    },
  );

  const independent = await mount(false);
  await writeFile(
    path.join(workspace, "independent.txt"),
    "independent new work",
  );
  let stale!: OverlayEpochTransition;
  await independent.withFrozen(id, async (verify, acknowledge, signal) => {
    const batch = await nativeBatch(
      identity,
      control,
      ["independent.txt"],
      verify,
    );
    await publisher.publish(batch, {
      nativeWindows: true,
      signal,
      validate: async (files) =>
        assert.equal(
          files.get("independent.txt")?.toString(),
          "independent new work",
        ),
      refresh: {
        request: batch.acknowledgement,
        checkpoint: batch.checkpoint,
        acknowledge,
      },
    });
    stale = request();
  });
  assert.equal(
    await readFile(path.join(source, "independent.txt"), "utf8"),
    "independent new work",
  );
  assert.equal(
    await readFile(path.join(source, "dep.txt"), "utf8"),
    "new dependency\n",
  );

  const staleManager = await mount(false);
  assert.ok(
    (await readFile(path.join(workspace, "renamed.txt"), "utf8")).includes(
      "old dependency",
    ),
  );
  await assert.rejects(
    staleManager.withFrozen(id, async (_v, _a, _s, _c, nextEpoch) =>
      nextEpoch(stale),
    ),
  );
  refused.add(staleManager);
  assert.equal(rows("SELECT epoch FROM local_state")[0]?.epoch, 5);
  assert.equal(rows("SELECT count(*) AS n FROM epoch_transitions")[0]?.n, 3);

  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    backend: "self-developed WinFsp Local overlay v6",
    failedCommandExit: result.exitCode,
    cancelledCommandDrained: true,
    failureAndCancellationPublished: false,
    freshReadAndIndependentPublication:
      "passed; source updates visible after a new epoch",
    retainedPrivateDependencies:
      "two-hop private derivation rejected before and after collection",
    replay:
      "committed transition idempotent across remount; unapplied stale seal rejected",
    finalEpoch: 5,
    transitions: 3,
    limitations: [
      "Host lifecycle PoC; product/Sandbox task integration pending",
      "No v5 migration, unclean restore, complete shell/LLM dependency isolation or conflict recomputation",
    ],
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `LOCAL_OVERLAY_EPOCHS PASS report=${path.join(root, "report.json")}\n`,
  );
} finally {
  const results = await Promise.allSettled(
    managers.map(async (manager) => {
      if (refused.has(manager)) {
        await assert.rejects(manager.close());
      } else {
        await manager.close();
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}
