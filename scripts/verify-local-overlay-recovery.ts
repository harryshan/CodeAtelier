/**
 * 手动验证完成态刷新恢复，使用独占 NTFS 夹具、真实 WinFsp 与多次独立宿主进程。
 * 1. publish worker 保存 complete/pending 后干净卸载退出，分别模拟确认前中断与确认后丢失回执。
 * 2. recover worker 从磁盘读取原批次，在新冻结租约中恢复；恢复途中回执丢失也保存 intent。
 * 3. 主进程验证来源后续修改、下一轮私有修改及未选产物保留；无收据的后来修改必须拒绝。
 * 4. 每个进程只关闭自己创建的挂载，结果写入实验目录；不修改项目、安装驱动或重启服务。
 * 这是干净卸载后的进程重启验证；不代表 dirty 卷、unknown 来源发布、Sandbox 或产品恢复通过。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logging/logger.js";
import { executeProcess } from "../src/tools/process.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";
import { durableJson, sourceIdentity } from "./local-overlay/files.js";
import { nativeBatch } from "./local-overlay/native-batch.js";
import { Publisher } from "./local-overlay/publisher.js";
import { validateBatch, type Batch } from "./local-overlay/session.js";

assert.equal(process.platform, "win32");

function context(root: string, id: string) {
  const log = createLogger(root, "info");

  return {
    root,
    id,
    source: path.join(root, "source"),
    control: path.join(root, "control"),
    workspace: overlayWorkspace(overlayNamespace(root), id),
    manager: new OverlayManager(root, log),
    publisher: new Publisher(path.join(root, "publisher"), log),
  };
}

async function mount(view: ReturnType<typeof context>, create: boolean) {
  await view.manager.start(
    view.id,
    view.source,
    view.control,
    view.workspace,
    create,
    AbortSignal.timeout(30_000),
    { kind: "local" },
  );
}

async function manifest(root: string) {
  const data = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  assert.match(data.id, /^[a-f0-9-]{36}$/);

  return { id: data.id as string, batch: validateBatch(data.batch) };
}

async function publishWorker(root: string, afterAck: boolean) {
  const view = context(root, randomUUID());
  await mkdir(view.source);
  await writeFile(path.join(view.source, "code.txt"), "original\n");
  try {
    await mount(view, true);
    assert.equal((await view.manager.metrics(view.id)).lowerEnumerations, 0);
    await writeFile(path.join(view.workspace, "code.txt"), "published\n");
    await writeFile(
      path.join(view.workspace, "artifact.txt"),
      "keep artifact\n",
    );
    await view.manager.withFrozen(
      view.id,
      async (verify, acknowledge, signal) => {
        const batch = await nativeBatch(
          await sourceIdentity(view.source),
          view.control,
          ["code.txt"],
          verify,
        );
        await durableJson(path.join(root, "manifest.json"), {
          id: view.id,
          batch,
        });
        const result = await view.publisher.publish(batch, {
          nativeWindows: true,
          signal,
          validate: async () => {},
          refresh: {
            request: batch.acknowledgement,
            checkpoint: batch.checkpoint,
            acknowledge: async (request) => {
              if (afterAck) {
                await acknowledge(request);
              }

              throw new Error("Injected completion interruption");
            },
          },
        });
        assert.equal(result.refreshPending, true);
        assert.equal((await view.publisher.inspect(batch)).state, "complete");
      },
    );
  } finally {
    await view.manager.close();
  }
}

async function recoverWorker(root: string, loseReceipt: boolean) {
  const saved = await manifest(root);
  const view = context(root, saved.id);
  try {
    await mount(view, false);
    await view.manager.withFrozen(
      view.id,
      async (_verify, acknowledge, signal) => {
        const operation = view.publisher.recoverRefresh(
          saved.batch,
          view.control,
          async (request) => {
            await acknowledge(request);
            if (loseReceipt) {
              throw new Error("Injected recovery receipt loss");
            }
          },
          { signal },
        );
        if (loseReceipt) {
          await assert.rejects(operation, /Injected recovery receipt loss/);
        } else {
          await operation;
        }
      },
    );
  } finally {
    await view.manager.close();
  }
}

async function worker(root: string, mode: string) {
  const result = await executeProcess(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      "--worker",
      root,
      mode,
    ],
    process.cwd(),
    AbortSignal.timeout(90_000),
    90_000,
    8192,
    () => {},
  );
  assert.equal(result.exitCode, 0, result.output);
}

async function withView(
  root: string,
  run: (view: ReturnType<typeof context>, batch: Batch) => Promise<void>,
) {
  const saved = await manifest(root);
  const view = context(root, saved.id);
  try {
    await mount(view, false);
    await run(view, saved.batch);
  } finally {
    await view.manager.close();
  }
}

async function verify() {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/local-overlay-recovery-"));
  for (const scenario of ["before", "after", "recovery-loss", "changed"]) {
    const directory = path.join(root, scenario);
    await mkdir(directory);
    await worker(
      directory,
      scenario === "after" ? "publish-after" : "publish-before",
    );
    const source = path.join(directory, "source", "code.txt");
    assert.equal(await readFile(source, "utf8"), "published\n");

    if (scenario === "before") {
      await writeFile(source, "later source\n");
      await worker(directory, "recover");
      await withView(directory, async (view, batch) => {
        assert.equal(
          await readFile(path.join(view.workspace, "code.txt"), "utf8"),
          "later source\n",
        );
        assert.equal(
          await readFile(path.join(view.workspace, "artifact.txt"), "utf8"),
          "keep artifact\n",
        );
        await view.manager.withFrozen(
          view.id,
          async (_verify, acknowledge, signal) => {
            assert.equal(
              (
                await view.publisher.recoverRefresh(
                  batch,
                  view.control,
                  acknowledge,
                  { signal },
                )
              ).alreadyConfirmed,
              true,
            );
          },
        );
      });
      assert.equal(await readFile(source, "utf8"), "later source\n");
    } else {
      if (scenario === "recovery-loss") {
        await worker(directory, "recover-loss");
      }

      await withView(directory, async (view, batch) => {
        await writeFile(
          path.join(view.workspace, "code.txt"),
          "later private\n",
        );
        await view.manager.withFrozen(
          view.id,
          async (_verify, acknowledge, signal) => {
            const operation = view.publisher.recoverRefresh(
              batch,
              view.control,
              acknowledge,
              { signal },
            );
            if (scenario === "changed") {
              await assert.rejects(operation, /NATIVE_REFRESH_CHANGED/);
            } else {
              await operation;
            }
          },
        );
      });
      await withView(directory, async (view) => {
        assert.equal(
          await readFile(path.join(view.workspace, "code.txt"), "utf8"),
          "later private\n",
        );
        assert.equal(
          await readFile(path.join(view.workspace, "artifact.txt"), "utf8"),
          "keep artifact\n",
        );
      });
      assert.equal(await readFile(source, "utf8"), "published\n");
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    backend: "self-developed native WinFsp Local v5",
    processRestart:
      "publish and recovery use separate Node processes with clean unmount",
    beforeAck:
      "unchanged private checkpoint rebound to current seal; later source retained and visible",
    afterAck: "original receipt replay preserves later private edits",
    recoveryReceiptLoss:
      "persisted recovery intent replay preserves later private edits",
    laterPrivateChanges:
      "unapplied acknowledgement rejected; edits and artifact retained",
    repeatedConfirmed: "idempotent; no helper acknowledgement or source write",
    limitations: [
      "No dirty-volume or unknown-source recovery",
      "Host fixture only; not production or Sandbox automatic publication",
      "No object GC, external-writer CAS or multi-file atomicity",
    ],
  };
  await durableJson(path.join(root, "report.json"), report);
  process.stdout.write(
    `LOCAL_OVERLAY_RECOVERY PASS report=${path.join(root, "report.json")}\n`,
  );
}

if (process.argv[2] === "--worker") {
  const root = process.argv[3]!;
  const mode = process.argv[4]!;
  if (mode.startsWith("publish-")) {
    await publishWorker(root, mode === "publish-after");
  } else {
    await recoverWorker(root, mode === "recover-loss");
  }
} else {
  await verify();
}
