/**
 * 手动验证新 Local WinFsp 视图与已安装 Windows Sandbox 的真实联动。
 * 1. 独占普通目录和两份 Local 挂载；实验注册适配器只验证卷身份并返回空 Git 写根。
 * 2. 一个生产 Engine/固定内存模型启动两个会话，通过模型屏障与命令时间区间证明并行。
 * 3. 专用账户读 lower、写私有层，尝试来源绝对路径写入和 .git 创建均须失败；无宿主 fallback。
 * 4. 取消正在运行的命令，再关闭 Engine/卸载/重挂载，使用相同历史续聊检查私有内容和租约。
 * 不替换 Runtime、Broker、ACL 或 IPC，不安装/Repair、不使用真实模型或用户仓库。
 * 本脚本尚不是产品注册/发布流程验收；所有测试实例排空后才卸载，失败现场保留。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { createLogger } from "../src/logging/logger.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { Store } from "../src/sessions/store.js";
import { directoryIdentity } from "../src/worktrees/git.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";

assert.equal(process.platform, "win32");
process.env.CODEATELIER_SANDBOX_ENABLED = "true";
process.env.CODEATELIER_BASE_URL = "http://127.0.0.1:1/v1";
process.env.CODEATELIER_MODEL = "local-overlay-verification";
process.env.CODEATELIER_API_KEY = "";
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-sandbox-"));
const source = path.join(root, "source");
await mkdir(source);
await mkdir(path.join(source, ".git"));
await writeFile(path.join(source, ".git", "sentinel"), "source metadata");
await writeFile(path.join(source, "base.txt"), "source content");
const config = new Config(path.join(root, "data"));
config.settings.maxConcurrentTasks = 2;
config.settings.maxSteps = 3;
const log = createLogger(root, "info");
const store = new Store(path.join(config.directory, "history.sqlite"));
let manager = new OverlayManager(root, log);
const views = ["A", "B"].map((label) => {
  const id = randomUUID();

  return {
    id,
    label,
    workspace: overlayWorkspace(overlayNamespace(root), id),
    control: path.join(root, `control-${label}`),
    identity: "",
  };
});

async function mount(create: boolean) {
  for (const view of views) {
    await manager.start(
      view.id,
      source,
      view.control,
      view.workspace,
      create,
      AbortSignal.timeout(30_000),
      { kind: "local" },
    );
    const identity = await directoryIdentity(view.workspace);
    if (view.identity) {
      assert.equal(identity, view.identity);
    }

    view.identity = identity;
  }
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 90_000;
  while (!(await predicate())) {
    assert(performance.now() < deadline, "Sandbox verification timed out");
    await delay(100);
  }
}

let phase: "parallel" | "cancel" | "restore" = "parallel";
const calls = new Map<string, number>();
const intervals = new Map<string, [number, number]>();
let arrived = 0;
let release!: () => void;
const barrier = new Promise<void>((resolve) => {
  release = resolve;
});
function command(label: string) {
  if (phase === "cancel") {
    return "Set-Content -LiteralPath 'cancel-start.txt' -Value 'started'; Start-Sleep -Seconds 60; Set-Content -LiteralPath 'cancel-finished.txt' -Value 'unexpected'";
  }

  if (phase === "restore") {
    return `whoami; if ((Get-Content -LiteralPath 'runtime.txt' -Raw).Trim() -ne '${label}') { throw 'Private content lost' }; Write-Output 'LOCAL_RESTORED_${label}'`;
  }

  const forbidden = path
    .join(source, `bypass-${label}.txt`)
    .replaceAll("'", "''");

  return [
    "$ErrorActionPreference = 'Stop'",
    "whoami",
    "$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "if ((Get-Content -LiteralPath 'base.txt' -Raw) -ne 'source content') { throw 'Wrong lower content' }",
    "if (Test-Path -LiteralPath '.git') { throw 'Metadata exposed' }",
    "$denied = $false; try { Set-Content -LiteralPath '.git' -Value 'forbidden' } catch { $denied = $true }; if (-not $denied) { throw 'Metadata creation allowed' }",
    `$denied = $false; try { Set-Content -LiteralPath '${forbidden}' -Value 'forbidden' } catch { $denied = $true }; if (-not $denied) { throw 'Source write allowed' }`,
    `Set-Content -LiteralPath 'runtime.txt' -Value '${label}'`,
    "Start-Sleep -Seconds 2",
    "$finished = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    `Write-Output "LOCAL_INTERVAL_${label}:$($started):$($finished)"`,
  ].join("; ");
}

const provider: ModelProvider = {
  async getCapabilities() {
    return {
      limits: { max_context_window_tokens: 64_000, max_output_tokens: 1_024 },
    };
  },
  async run(input, _instructions, _tools, signal) {
    const serialized = JSON.stringify(input);
    const label = serialized.includes("LOCAL_SESSION_A") ? "A" : "B";
    const key = `${phase}-${label}`;
    const count = calls.get(key) ?? 0;
    calls.set(key, count + 1);
    if (count === 0) {
      if (phase === "parallel") {
        if (++arrived === 2) {
          release();
        }

        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void barrier.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          });
          if (signal.aborted) {
            abort();
          }
        });
      }

      return {
        text: "",
        output: [
          {
            type: "function_call",
            call_id: key,
            name: "run_command",
            arguments: JSON.stringify({
              execution: { id: key, dependsOn: [] },
              arguments: { command: command(label) },
            }),
          },
        ],
      };
    }

    assert.match(serialized, /codeateliersandbox/i);
    if (phase === "parallel") {
      const match = new RegExp(`LOCAL_INTERVAL_${label}:(\\d+):(\\d+)`).exec(
        serialized,
      );
      assert.ok(match, "Runtime command did not finish its assertions");
      intervals.set(label, [Number(match[1]), Number(match[2])]);
    } else {
      assert.match(serialized, new RegExp(`LOCAL_RESTORED_${label}`));
    }

    return { text: "verified", output: [] };
  },
};

function createEngine() {
  const result = new Engine(store, config, log, () => provider);
  // Substitute only experimental registration. All Runtime and root grants are
  // production paths; neither source nor common Git directory is granted here.
  result.worktrees.validate = async (workspace) => {
    const view = views.find((candidate) => candidate.workspace === workspace);
    assert.ok(view, "Unknown experimental view");
    assert.equal(await directoryIdentity(workspace), view.identity);

    return undefined;
  };

  result.worktrees.gitWriteRoots = async (workspace) => {
    await result.worktrees.validate(workspace);

    return [];
  };

  return result;
}

function assertRuntime(
  sessionId: string,
  taskId: string,
  state: "completed" | "cancelled",
) {
  const events = store
    .events(sessionId)
    .filter((event) => event.taskId === taskId);
  assert.equal(store.task(taskId)?.status, state);
  assert(
    events.some(
      (event) =>
        event.type === "execution_instance" &&
        event.data.kind === "agent-runtime" &&
        event.data.mode === "windows-sandbox-user" &&
        event.data.state === state &&
        event.data.sandboxApplied === true,
    ),
  );
  assert(
    !events.some(
      (event) =>
        ["sandbox_fallback", "sandbox_warning"].includes(event.type) ||
        (event.type === "execution_instance" && event.data.state === "unknown"),
    ),
  );
}

let engine = createEngine();
try {
  await mount(true);
  const sessions = views.map((view) =>
    store.create(view.workspace, `Local Sandbox ${view.label}`),
  );
  const tasks = [];
  for (const [index, session] of sessions.entries()) {
    tasks.push(
      await engine.start(
        session.id,
        `LOCAL_SESSION_${views[index]!.label}: run the fixed probe.`,
      ),
    );
  }

  await until(async () => !(await engine.hasActiveTasks()));
  for (const [index, task] of tasks.entries()) {
    assertRuntime(sessions[index]!.id, task.id, "completed");
    assert.equal(
      (
        await readFile(
          path.join(views[index]!.workspace, "runtime.txt"),
          "utf8",
        )
      ).trim(),
      views[index]!.label,
    );
  }

  const a = intervals.get("A")!;
  const b = intervals.get("B")!;
  assert(
    Math.max(a[0], b[0]) < Math.min(a[1], b[1]),
    "Commands did not overlap",
  );
  assert.equal(
    engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
    0,
  );
  for (const name of ["runtime.txt", "bypass-A.txt", "bypass-B.txt"]) {
    await assert.rejects(readFile(path.join(source, name)), { code: "ENOENT" });
  }

  assert.equal(
    await readFile(path.join(source, ".git", "sentinel"), "utf8"),
    "source metadata",
  );

  phase = "cancel";
  const cancelled = await engine.start(
    sessions[0]!.id,
    "LOCAL_SESSION_A: run the cancellation probe.",
  );
  await until(async () => {
    try {
      return (
        (
          await readFile(
            path.join(views[0]!.workspace, "cancel-start.txt"),
            "utf8",
          )
        ).trim() === "started"
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      return false;
    }
  });
  engine.cancel(cancelled.id);
  await until(async () => !(await engine.hasActiveTasks()));
  assertRuntime(sessions[0]!.id, cancelled.id, "cancelled");
  await assert.rejects(
    readFile(path.join(views[0]!.workspace, "cancel-finished.txt")),
    { code: "ENOENT" },
  );
  assert.equal(
    engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
    0,
  );
  await engine.close();
  await manager.close();

  phase = "restore";
  manager = new OverlayManager(root, log);
  await mount(false);
  engine = createEngine();
  const resumed = await engine.start(
    sessions[0]!.id,
    "LOCAL_SESSION_A: verify persisted private content.",
  );
  await until(async () => !(await engine.hasActiveTasks()));
  assertRuntime(sessions[0]!.id, resumed.id, "completed");
  assert.equal(
    engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
    0,
  );
  await engine.close();
  await manager.close();
  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    backend: "Local WinFsp + installed dedicated-account Runtime",
    registration:
      "experimental identity adapter; not product session integration",
    parallelRuntimeCommands: "passed",
    commandIntervals: Object.fromEntries(intervals),
    sourceAbsoluteWrite: "denied",
    gitMetadataCreation: "denied",
    sourceGitWriteRootsGranted: 0,
    privateWrites: "independent",
    cancelRunningCommand: "passed",
    remountAndContinue: "passed",
    fallback: false,
    activeLeasesAfterTasks: 0,
    cleanup: "engine drained; helpers cleanly stopped",
    limitations: [
      "Not an OS security boundary between sessions",
      "No changeset export or automatic publication in this verifier",
    ],
  };
  const file = path.join(root, "report.json");
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`LOCAL_OVERLAY_SANDBOX PASS report=${file}\n`);
} finally {
  await engine.close();
  await manager.close();
  await store.closeAsync();
}
