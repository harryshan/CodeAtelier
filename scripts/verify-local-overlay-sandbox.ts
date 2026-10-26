/**
 * 手动验证新 Local WinFsp 视图与已安装 Windows Sandbox 的真实联动。
 * 1. 独占普通目录和两份 Local 视图，使用生产 LocalOverlayService 绑定持久会话。
 * 2. 一个生产 Engine/固定内存模型启动两个会话，通过模型屏障与命令时间区间证明并行。
 * 3. 专用账户读 lower、写私有层，尝试来源绝对路径写入和 .git 创建均须失败；无宿主 fallback。
 * 4. 取消正在运行的命令，再关闭/新建 Engine，自动按相同历史重挂载并续聊检查私有内容和租约。
 * 不替换 Runtime、Broker、ACL 或 IPC，不安装/Repair、不使用真实模型或用户仓库。
 * 5. --publish 使用可信内部选择和精确候选字节验证，成功轮次发布指定新文件；取消轮次选择不执行。
 * 6. --commands 由固定 provider 返回 local_publish 工具，经实际 Runtime IPC 绑定计划，再验证成功、非零退出、冲突和取消。
 * 7. --commands --merge 让两个 Runtime 从同一文件原文独立编辑不同位置，编辑屏障后才允许发布；检查第二候选含双方修改。
 * 验证内部会话生命周期；候选 Sandbox 命令仅由 --commands 覆盖，不经公开 HTTP 创建入口。失败现场保留。
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
import type { Session } from "../src/shared/types.js";
import { Store } from "../src/sessions/store.js";

assert.equal(process.platform, "win32");
const commands = process.argv.includes("--commands");
const merge = process.argv.includes("--merge");
assert(!merge || commands, "--merge requires --commands");
const publish = commands || process.argv.includes("--publish");
let validated = 0;
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
const sharedBase = "left\nmiddle\nright\n";
const sharedMerged = "left-A\nmiddle\nright-B\n";
if (merge) {
  await writeFile(path.join(source, "shared.txt"), sharedBase);
}

const config = new Config(path.join(root, "data"));
config.settings.maxConcurrentTasks = 2;
config.settings.maxSteps = 3;
const log = createLogger(root, "info");
const store = new Store(path.join(config.directory, "history.sqlite"));
const views = ["A", "B"].map((label) => {
  const id = randomUUID();

  return {
    id,
    label,
    workspace: "",
    sessionId: "",
  };
});

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 90_000;
  while (!(await predicate())) {
    assert(performance.now() < deadline, "Sandbox verification timed out");
    await delay(100);
  }
}

let phase: "parallel" | "validation" | "conflict" | "cancel" | "restore" =
  "parallel";
const calls = new Map<string, number>();
const intervals = new Map<string, [number, number]>();
const sharedCandidates: string[] = [];
let arrived = 0;
let release!: () => void;
const barrier = new Promise<void>((resolve) => {
  release = resolve;
});
let edited = 0;
let releaseEdits!: () => void;
const editsReady = new Promise<void>((resolve) => {
  releaseEdits = resolve;
});

async function waitForPeer(ready: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void ready.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

function command(label: string) {
  if (phase === "validation" || phase === "conflict") {
    const file = phase === "validation" ? "rejected.txt" : "source-A.txt";

    return `whoami; Set-Content -LiteralPath '${file}' -Value 'private rejected'; Write-Output 'LOCAL_REJECTION_READY'`;
  }

  if (phase === "cancel") {
    if (commands) {
      return "whoami; Set-Content -LiteralPath 'cancel-start.txt' -Value 'started'";
    }

    return "Set-Content -LiteralPath 'cancel-start.txt' -Value 'started'; Start-Sleep -Seconds 60; Set-Content -LiteralPath 'cancel-finished.txt' -Value 'unexpected'";
  }

  if (phase === "restore") {
    const retained =
      publish && label === "A"
        ? "if ((Get-Content -LiteralPath 'rejected.txt' -Raw).Trim() -ne 'private rejected') { throw 'Rejected content lost' }; if ((Get-Content -LiteralPath 'source-A.txt' -Raw).Trim() -ne 'private rejected') { throw 'Conflict content lost' }; "
        : "";

    return `whoami; if ((Get-Content -LiteralPath 'runtime.txt' -Raw).Trim() -ne '${label}') { throw 'Private content lost' }; if (Test-Path -LiteralPath 'cancel-finished.txt') { throw 'Cancelled command survived' }; ${retained}Write-Output 'LOCAL_RESTORED_${label}'`;
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
    ...(merge
      ? [
          "$shared = Get-Content -LiteralPath 'shared.txt' -Raw",
          "if ($shared -ne \"left`nmiddle`nright`n\") { throw 'Shared baseline changed before both edits' }",
          `$shared = $shared.Replace('${label === "A" ? "left" : "right"}', '${label === "A" ? "left-A" : "right-B"}')`,
          "Set-Content -LiteralPath 'shared.txt' -Value $shared -NoNewline -Encoding ascii",
        ]
      : []),
    ...(publish
      ? [
          `Set-Content -LiteralPath 'source-${label}.txt' -Value 'published ${label}'`,
        ]
      : []),
    "Start-Sleep -Seconds 2",
    "$finished = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    `Write-Output "LOCAL_INTERVAL_${label}:$($started):$($finished)"`,
  ].join("; ");
}

function selectResponse(key: string, paths: string[], validation: string[]) {
  return {
    text: "",
    output: [
      {
        type: "function_call" as const,
        call_id: `${key}-select`,
        name: "local_publish",
        arguments: JSON.stringify({
          execution: { id: `${key}-select`, dependsOn: [] },
          arguments: {
            request: { action: "select", paths, commands: validation },
          },
        }),
      },
    ],
  };
}

const provider: ModelProvider = {
  async getCapabilities() {
    return {
      limits: { max_context_window_tokens: 64_000, max_output_tokens: 1_024 },
    };
  },
  async run(input, instructions, tools, signal) {
    assert.match(instructions, /private Local overlay view/);
    if (commands) {
      assert(tools.some((tool: any) => tool.name === "local_publish"));
    }

    const serialized = JSON.stringify(input);
    const label = serialized.includes("LOCAL_SESSION_A") ? "A" : "B";
    const key = `${phase}-${label}`;
    const count = calls.get(key) ?? 0;
    calls.set(key, count + 1);
    if (count === 0) {
      if (publish && phase === "cancel" && !commands) {
        const view = views.find((view) => view.label === label)!;
        const active = engine.activeTasks.find(
          (task) => task.sessionId === view.sessionId,
        )!;
        await engine.localOverlays.select(
          view.workspace,
          active.sessionId,
          active.id,
          {
            paths: ["cancel-start.txt"],
            validate: async () => {
              assert.fail("Cancelled task must not validate or publish");
            },
          },
        );
      }

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
    if (commands && count === 2) {
      const feedback = (input as any[]).find(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === `${key}-select`,
      );
      assert.ok(feedback, "Selection tool receipt missing");
      assert.deepEqual(JSON.parse(feedback.output), {
        selected: merge && phase === "parallel" ? 2 : 1,
        published: false,
      });

      return {
        text: "Selection registered; publication still pending.",
        output: [],
      };
    }

    if (commands && phase === "cancel") {
      return selectResponse(
        key,
        ["cancel-start.txt"],
        [
          "Write-Output 'CANDIDATE_RUNNING'; Start-Sleep -Seconds 60; Set-Content -LiteralPath 'cancel-finished.txt' -Value 'unexpected'",
        ],
      );
    }

    if (phase === "parallel") {
      const match = new RegExp(`LOCAL_INTERVAL_${label}:(\\d+):(\\d+)`).exec(
        serialized,
      );
      assert.ok(match, "Runtime command did not finish its assertions");
      intervals.set(label, [Number(match[1]), Number(match[2])]);
      if (merge) {
        if (++edited === 2) {
          assert.equal(
            await readFile(path.join(source, "shared.txt"), "utf8"),
            sharedBase,
          );
          releaseEdits();
        }

        // Neither task may publish until both real Runtime edits have finished.
        await waitForPeer(editsReady, signal);
      }

      if (publish) {
        const view = views.find((view) => view.label === label)!;
        const active = engine.activeTasks.find(
          (task) => task.sessionId === view.sessionId,
        )!;
        if (commands) {
          return selectResponse(
            key,
            [`source-${label}.txt`, ...(merge ? ["shared.txt"] : [])],
            [
              `whoami; if ((Get-Content -LiteralPath 'source-${label}.txt' -Raw).Trim() -ne 'published ${label}') { throw 'Wrong candidate' }; if ((Test-Path -LiteralPath 'runtime.txt') -or (Test-Path -LiteralPath '.git')) { throw 'Private content exposed' }; Set-Content -LiteralPath 'candidate-artifact.txt' -Value 'private'`,
              "if ((Get-Content -LiteralPath 'candidate-artifact.txt' -Raw).Trim() -ne 'private') { throw 'Plan ordering failed' }" +
                (merge
                  ? `; $shared = Get-Content -LiteralPath 'shared.txt' -Raw; if (-not $shared.Contains('${label === "A" ? "left-A" : "right-B"}')) { throw 'Own edit missing from candidate' }; Write-Output ('SHARED_CANDIDATE:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($shared)))`
                  : ""),
            ],
          );
        } else {
          await engine.localOverlays.select(
            view.workspace,
            active.sessionId,
            active.id,
            {
              paths: [`source-${label}.txt`],
              validate: async (files, signal) => {
                signal?.throwIfAborted();
                assert.equal(files.size, 1);
                assert.equal(
                  files.get(`source-${label}.txt`)?.toString("utf8").trim(),
                  `published ${label}`,
                );
                validated++;
              },
            },
          );
        }
      }
    } else if (phase === "validation" || phase === "conflict") {
      assert.match(serialized, /LOCAL_REJECTION_READY/);
      if (phase === "conflict") {
        await writeFile(path.join(source, "source-A.txt"), "external winner\n");
      }

      const active = engine.activeTasks.find(
        (task) => task.sessionId === views[0]!.sessionId,
      )!;
      if (commands) {
        return selectResponse(
          key,
          [phase === "validation" ? "rejected.txt" : "source-A.txt"],
          ["exit 7", "throw 'Must not run after failure'"],
        );
      } else {
        await engine.localOverlays.select(
          views[0]!.workspace,
          active.sessionId,
          active.id,
          {
            paths: [phase === "validation" ? "rejected.txt" : "source-A.txt"],
            validate: async () => {
              throw new Error("Expected candidate validation refusal");
            },
          },
        );
      }
    } else if (phase === "restore") {
      assert.match(serialized, new RegExp(`LOCAL_RESTORED_${label}`));
    }

    return { text: "verified", output: [] };
  },
};

function createEngine() {
  return new Engine(store, config, log, () => provider);
}

function assertRuntime(
  sessionId: string,
  taskId: string,
  state: "completed" | "cancelled" | "failed",
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
        event.data.state === (state === "failed" ? "completed" : state) &&
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
  assert(
    events.some(
      (event) =>
        event.type === "local_overlay" &&
        event.data.published === (publish && phase === "parallel"),
    ),
  );
}

let engine = createEngine();
try {
  const sessions: Session[] = [];
  for (const view of views) {
    const session = await engine.localOverlays.create(
      { id: view.id, source },
      async (workspace) =>
        store.list().find((saved) => saved.workspace === workspace) ??
        store.create(workspace, `Local Sandbox ${view.label}`),
    );
    view.workspace = session.workspace;
    view.sessionId = session.id;
    sessions.push(session);
    assert.equal(
      await engine.localOverlays.projectWorkspace(view.workspace),
      source,
    );
    assert.deepEqual(await engine.worktrees.gitWriteRoots(view.workspace), []);
  }

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
    const record = await engine.localOverlays.validate(
      views[index]!.workspace,
      sessions[index]!.id,
    );
    assert.equal(record?.phase, "ready");
    assert.equal(record.epoch, 1);
    // Idle sessions retain private disk state but have no live filesystem mount.
    await assert.rejects(
      readFile(path.join(views[index]!.workspace, "runtime.txt")),
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

  if (publish) {
    for (const label of ["A", "B"]) {
      assert.equal(
        (
          await readFile(path.join(source, `source-${label}.txt`), "utf8")
        ).trim(),
        `published ${label}`,
      );
    }

    if (commands) {
      for (const session of sessions) {
        const events = store.events(session.id);
        if (merge) {
          const output = events
            .filter(
              (event) =>
                event.type === "local_validation" &&
                event.data.event === "command_output",
            )
            .map((event) => event.data.data.text)
            .join("");
          const candidates = [
            ...output.matchAll(/SHARED_CANDIDATE:([A-Za-z0-9+/=]+)/g),
          ];
          assert.equal(
            candidates.length,
            1,
            "Each candidate must report exactly one shared file",
          );
          sharedCandidates.push(
            Buffer.from(candidates[0]![1]!, "base64").toString("utf8"),
          );
        }

        assert.equal(
          events.filter(
            (event) =>
              event.type === "execution_instance" &&
              event.data.purpose === "local-validation" &&
              event.data.state === "completed",
          ).length,
          1,
        );
        assert.equal(
          events.filter(
            (event) =>
              event.type === "local_validation" &&
              event.data.event === "tool_result",
          ).length,
          2,
        );
      }

      if (merge) {
        assert.equal(
          await readFile(path.join(source, "shared.txt"), "utf8"),
          sharedMerged,
        );
        assert.equal(
          sharedCandidates.filter((content) => content === sharedMerged).length,
          1,
        );
        assert.equal(
          sharedCandidates.filter((content) =>
            ["left-A\nmiddle\nright\n", "left\nmiddle\nright-B\n"].includes(
              content,
            ),
          ).length,
          1,
        );
      }
    } else {
      assert.equal(validated, 2);
    }
  }

  assert.equal(
    await readFile(path.join(source, ".git", "sentinel"), "utf8"),
    "source metadata",
  );

  if (publish) {
    for (const rejection of ["validation", "conflict"] as const) {
      phase = rejection;
      const rejected = await engine.start(
        sessions[0]!.id,
        `LOCAL_SESSION_A: ${rejection} probe.`,
      );
      await until(async () => !(await engine.hasActiveTasks()));
      assertRuntime(sessions[0]!.id, rejected.id, "failed");
      const record = await engine.localOverlays.validate(views[0]!.workspace);
      assert.equal(record?.phase, "ready");
      assert.equal(record.publication?.state, "rejected");
      if (rejection === "validation") {
        assert.equal(
          record.publication.reason,
          commands ? "CANDIDATE_VALIDATION_FAILED" : "VALIDATION_FAILED",
        );
      } else {
        assert.notEqual(record.publication.reason, "VALIDATION_FAILED");
      }

      await assert.rejects(readFile(path.join(source, "rejected.txt")), {
        code: "ENOENT",
      });
    }

    assert.equal(
      await readFile(path.join(source, "source-A.txt"), "utf8"),
      "external winner\n",
    );
  }

  phase = "cancel";
  const cancelled = await engine.start(
    sessions[0]!.id,
    "LOCAL_SESSION_A: run the cancellation probe.",
  );
  // The idle UNC intentionally does not exist. Poll the real Runtime start
  // event before touching its files; WinFsp reports UNKNOWN for an unmounted UNC.
  await until(() =>
    store
      .events(sessions[0]!.id)
      .some(
        (event) =>
          event.taskId === cancelled.id &&
          event.type === "execution_instance" &&
          event.data.state === "running",
      ),
  );
  await until(async () => {
    if (commands) {
      return store
        .events(sessions[0]!.id)
        .some(
          (event) =>
            event.taskId === cancelled.id &&
            event.type === "local_validation" &&
            event.data.event === "command_output" &&
            event.data.data.text.includes("CANDIDATE_RUNNING"),
        );
    }

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
  assert.equal(
    (await engine.localOverlays.validate(views[0]!.workspace))?.epoch,
    publish ? 4 : 2,
  );
  assert.equal(
    engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
    0,
  );
  await engine.close();

  phase = "restore";
  engine = createEngine();
  for (const [index, session] of sessions.entries()) {
    const resumed = await engine.start(
      session.id,
      `LOCAL_SESSION_${views[index]!.label}: verify persisted private content.`,
    );
    await until(async () => !(await engine.hasActiveTasks()));
    assertRuntime(session.id, resumed.id, "completed");
  }

  const epochs: Record<string, number> = {};
  for (const [index, view] of views.entries()) {
    const record = await engine.localOverlays.validate(
      view.workspace,
      sessions[index]!.id,
    );
    assert.equal(record?.phase, "ready");
    assert.equal(record.epoch, index === 0 ? (publish ? 5 : 3) : 2);
    epochs[view.label] = record.epoch;
    await assert.rejects(readFile(path.join(view.workspace, "runtime.txt")));
  }

  for (const file of [
    "runtime.txt",
    "cancel-start.txt",
    "cancel-finished.txt",
    "candidate-artifact.txt",
  ]) {
    await assert.rejects(readFile(path.join(source, file)), { code: "ENOENT" });
  }

  assert.equal(
    engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
    0,
  );
  await engine.close();
  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    backend: "Local WinFsp + installed dedicated-account Runtime",
    registration:
      "production LocalOverlayService internal Engine lifecycle; no registration overrides",
    parallelRuntimeCommands: "passed",
    commandIntervals: Object.fromEntries(intervals),
    sourceAbsoluteWrite: "denied",
    gitMetadataCreation: "denied",
    sourceGitWriteRootsGranted: 0,
    privateWrites: "independent",
    cancelRunningCommand: commands ? "candidate Runtime drained" : "passed",
    remountAndContinue: "both sessions passed after Engine recreation",
    epochs,
    publication: publish
      ? merge
        ? "two batches each selected an independent file and shared.txt; all three source files published; cancelled selection retained"
        : "two selected files automatically published; cancelled selection retained"
      : "not selected",
    rejection: publish
      ? "candidate failure and source conflict preserved; both private results survived restart"
      : "not requested",
    selection: commands
      ? "model local_publish tool through authenticated Runtime IPC"
      : "trusted internal caller",
    validation: commands
      ? "production Engine command plan and candidate Runtime; ordered success, exit rejection and cancellation"
      : publish
        ? "exact merged candidate bytes; no validation command executed"
        : "not requested",
    sharedFileMerge: merge
      ? {
          baseline: sharedBase,
          candidates: sharedCandidates,
          published: sharedMerged,
        }
      : "not requested",
    fallback: false,
    activeLeasesAfterTasks: 0,
    cleanup: "engine drained; helpers cleanly stopped",
    limitations: [
      "Not an OS security boundary between sessions",
      "Public UI/API creation not exercised by this verifier; fixed provider, not a real model evaluation",
    ],
  };
  const file = path.join(root, "report.json");
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`LOCAL_OVERLAY_SANDBOX PASS report=${file}\n`);
} finally {
  await engine.close();
  await store.closeAsync();
}
