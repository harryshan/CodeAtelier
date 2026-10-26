/**
 * 手动验收真实浏览器到 Local WinFsp/Sandbox 的产品闭环，不进入默认 check/Evaluation。
 * 1. 独占夹具保存 v1 设置，生产 createApp 在临时回环端口启动；固定 provider 是唯一模型替身。
 * 2. Chromium 通过真实创建弹窗、HTTP/SSE 和任务输入启动双 Local 会话，不拦截路由或替换挂载/Runtime。
 * 3. 模型屏障验证双 Runtime 并行，local_publish 选择经真实候选 Runtime 发布；页面及持久快照核对结果。
 * 4. 来源冲突后用真实检查/继续 UI 创建参考会话，保留未发送草稿且不自动启动任务；重启本夹具服务后核对历史。
 * 5. finally 关闭本脚本的浏览器、服务和任务，保留报告/截图/失败现场；不重启实际用户服务、不安装/Repair。
 * 6. --interrupted 追加真实中断 helper/owner、UI 检查/新参考会话及 Sandbox 重编辑/候选发布；遗留 active 清单/服务锁为夹具注入。
 * 7. --refresh 在真实任务收尾注入确认前/后回执丢失，经页面恢复并以新 Sandbox 任务验证当前来源和未选私有文件。
 * 8. 正常任务收尾后核对候选控制目录和持久 ACL 身份记录均回收，私有会话保留不受影响。
 * 启动沿用生产 Sandbox 账户恢复流程，应在没有其它 Sandbox 任务时运行；不是隔离的第二套系统账户。
 * 仅 Windows 安装态合成小文件验证，不证明真实模型能力、任意工程语义或跨平台隔离。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Page } from "@playwright/test";
import { Config } from "../src/config/config.js";
import { SettingsStore } from "../src/config/settings-store.js";
import { createLogger } from "../src/logging/logger.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { createApp } from "../src/server/app.js";
import type { Session, Snapshot, Task } from "../src/shared/types.js";
import { interruptedBrowser } from "./fixtures/local-interrupted-browser.js";
import { privateRefreshBrowser } from "./fixtures/local-private-refresh-browser.js";

assert.equal(process.platform, "win32");
const interrupted = process.argv.includes("--interrupted");
const refresh = process.argv.includes("--refresh");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-browser-"));
const source = path.join(root, "source");
const data = path.join(root, "data");
await mkdir(source);
await mkdir(data);
await mkdir(path.join(source, ".git"));
await writeFile(path.join(source, ".git", "sentinel"), "metadata");
await writeFile(path.join(source, "base.txt"), "lower");
if (interrupted) {
  for (const name of ["edit.txt", "gone.txt", "partial.txt"]) {
    await writeFile(path.join(source, name), "original");
  }
}

const settings = new SettingsStore(data);
await settings.update({
  expectedRevision: settings.view().revision,
  confirmSensitive: true,
  secretChanges: { mainKey: "local-verification-placeholder" },
  changes: {
    models: {
      main: { baseUrl: "http://127.0.0.1:1/v1", model: "browser-fixture" },
    },
    execution: { maxSteps: 3, maxConcurrentTasks: 2 },
    sandbox: { enabled: true },
  },
});

const log = createLogger(root, "info");
let phase:
  "parallel" | "conflict" | "interrupted" | "refresh-edit" | "refresh-check" =
  "parallel";
let referenceDirectory = "";
let arrivals = 0;
let release!: () => void;
const barrier = new Promise<void>((resolve) => {
  release = resolve;
});
const calls = new Map<string, number>();
const intervals = new Map<string, [number, number]>();

function tool(callId: string, name: string, args: unknown) {
  return {
    text: "",
    output: [
      {
        type: "function_call" as const,
        call_id: callId,
        name,
        arguments: JSON.stringify({
          execution: { id: callId, dependsOn: [] },
          arguments: args,
        }),
      },
    ],
  };
}

function editCommand(label: string) {
  if (phase === "refresh-edit") {
    return "$ErrorActionPreference = 'Stop'; whoami; Set-Content -LiteralPath 'refresh.txt' -Value 'published refresh' -NoNewline -Encoding ascii; Set-Content -LiteralPath 'unselected-refresh.txt' -Value 'retained privately' -NoNewline -Encoding ascii; Write-Output 'REFRESH_EDITED'";
  }

  if (phase === "refresh-check") {
    return "$ErrorActionPreference = 'Stop'; whoami; if ((Get-Content -LiteralPath 'refresh.txt' -Raw) -ne 'external after refresh') { throw 'Source overwritten or stale' }; if ((Get-Content -LiteralPath 'unselected-refresh.txt' -Raw) -ne 'retained privately') { throw 'Private file lost' }; Write-Output 'REFRESH_FOLLOWUP'";
  }

  if (phase === "interrupted") {
    return [
      "$ErrorActionPreference = 'Stop'",
      "whoami",
      `$reference = Get-Content -LiteralPath '${referenceDirectory}/manifest.json' -Raw | ConvertFrom-Json`,
      "if ($reference.version -ne 3 -or $reference.state -ne 'interrupted') { throw 'Wrong reference state' }",
      "$entry = $reference.entries | Where-Object { $_.path -eq 'partial.txt' }",
      `$partial = Get-Content -LiteralPath ('${referenceDirectory}/' + $entry.directory + '/interrupted-private') -Raw`,
      "if ($partial -ne 'private prefix only') { throw 'Partial reference lost' }",
      "if ((Get-Content -LiteralPath 'partial.txt' -Raw) -ne 'current source') { throw 'Old bytes applied or latest lower missing' }",
      "Set-Content -LiteralPath 'partial.txt' -Value 'resolved from current source' -NoNewline -Encoding ascii",
      "Write-Output 'INTERRUPTED_EDITED'",
    ].join("; ");
  }

  if (phase === "conflict") {
    return "whoami; Set-Content -LiteralPath 'source-A.txt' -Value 'private conflict'; Write-Output 'CONFLICT_EDITED'";
  }

  const forbidden = path
    .join(source, `bypass-${label}.txt`)
    .replaceAll("'", "''");

  return [
    "$ErrorActionPreference = 'Stop'",
    "whoami",
    "$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "if ((Get-Content -LiteralPath 'base.txt' -Raw) -ne 'lower') { throw 'Lower missing' }",
    "if (Test-Path -LiteralPath '.git') { throw 'Git metadata exposed' }",
    `$denied = $false; try { Set-Content -LiteralPath '${forbidden}' -Value 'bad' } catch { $denied = $true }; if (-not $denied) { throw 'Source write allowed' }`,
    `Set-Content -LiteralPath 'runtime.txt' -Value '${label}'`,
    `Set-Content -LiteralPath 'source-${label}.txt' -Value 'published ${label}'`,
    "Start-Sleep -Seconds 2",
    "$finished = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    `Write-Output "UI_INTERVAL_${label}:$($started):$($finished)"`,
  ].join("; ");
}

const provider: ModelProvider = {
  async getCapabilities() {
    return {
      limits: { max_context_window_tokens: 64000, max_output_tokens: 1024 },
    };
  },
  async run(input, instructions, tools, signal) {
    const serialized = JSON.stringify(input);
    const label = serialized.includes("LOCAL UI B") ? "B" : "A";
    if (!instructions.includes("private Local overlay view")) {
      return {
        text: serialized.includes("LOCAL refresh before")
          ? "Local refresh before"
          : serialized.includes("LOCAL refresh after")
            ? "Local refresh after"
            : serialized.includes("LOCAL UI interrupted reference")
              ? "Local interrupted reference"
              : `Local fixture ${label}`,
        output: [],
      };
    }

    assert(
      tools.some((definition: any) => definition.name === "local_publish"),
    );
    const key = `${phase}-${label}`;
    const count = calls.get(key) ?? 0;
    calls.set(key, count + 1);
    if (phase === "interrupted") {
      assert.match(instructions, /partial operation/);
      assert.match(instructions, /untrusted historical data/);
      const match = /\.codeatelier-recovery-[a-f0-9-]{36}/.exec(instructions);
      assert(match);
      referenceDirectory = match[0];
    }

    if (count === 0) {
      if (phase === "parallel") {
        if (++arrivals === 2) {
          release();
        }

        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          void barrier.then(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
          });
        });
      }

      return tool(`${key}-edit`, "run_command", {
        command: editCommand(label),
      });
    }

    assert.match(serialized, /codeateliersandbox/i);
    if (count === 1) {
      if (phase === "refresh-check") {
        assert.match(serialized, /REFRESH_FOLLOWUP/);

        return {
          text: "Fresh source and retained private file verified",
          output: [],
        };
      }

      if (phase === "refresh-edit") {
        assert.match(serialized, /REFRESH_EDITED/);

        return tool(`${key}-select`, "local_publish", {
          request: {
            action: "select",
            paths: ["refresh.txt"],
            commands: [
              "$ErrorActionPreference = 'Stop'; whoami; if ((Get-Content -LiteralPath 'refresh.txt' -Raw) -ne 'published refresh') { throw 'Candidate differs' }; if (Test-Path -LiteralPath 'unselected-refresh.txt') { throw 'Unselected private file leaked' }",
            ],
          },
        });
      }

      if (phase === "interrupted") {
        assert.match(serialized, /INTERRUPTED_EDITED/);

        return tool(`${key}-select`, "local_publish", {
          request: {
            action: "select",
            paths: ["partial.txt"],
            commands: [
              `$ErrorActionPreference = 'Stop'; whoami; if ((Get-Content -LiteralPath 'partial.txt' -Raw) -ne 'resolved from current source') { throw 'Wrong candidate' }; if (Test-Path -LiteralPath '${referenceDirectory}') { throw 'Reference leaked to candidate' }`,
            ],
          },
        });
      }

      if (phase === "parallel") {
        const match = new RegExp(`UI_INTERVAL_${label}:(\\d+):(\\d+)`).exec(
          serialized,
        );
        assert(match, "Real Runtime command did not finish");
        intervals.set(label, [Number(match[1]), Number(match[2])]);
      } else {
        assert.match(serialized, /CONFLICT_EDITED/);
        await writeFile(path.join(source, "source-A.txt"), "external winner\n");
      }

      return tool(`${key}-select`, "local_publish", {
        request: {
          action: "select",
          paths: [`source-${label}.txt`],
          commands: [
            `whoami; if ((Get-Content -LiteralPath 'source-${label}.txt' -Raw).Trim() -ne 'published ${label}') { throw 'Wrong candidate' }; if ((Test-Path -LiteralPath 'runtime.txt') -or (Test-Path -LiteralPath '.git')) { throw 'Private file exposed' }`,
          ],
        },
      });
    }

    const receipt = (input as any[]).find(
      (item) =>
        item.type === "function_call_output" &&
        item.call_id === `${key}-select`,
    );
    assert(receipt);
    assert.deepEqual(JSON.parse(receipt.output), {
      selected: 1,
      published: false,
    });

    return { text: `UI fixture ${label} finished`, output: [] };
  },
};

let server = await createApp(
  new Config(data, { legacy: false }),
  log,
  () => provider,
);
let address = await server.app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium
  .launch({ headless: true })
  .catch(async (error) => {
    await server.shutdown();
    throw error;
  });
const context = await browser.newContext({
  viewport: { width: 1400, height: 1050 },
});
context.setDefaultTimeout(15000);
const pages = [await context.newPage(), await context.newPage()];
const pageErrors: string[] = [];
for (const page of pages) {
  page.on("pageerror", (error) => pageErrors.push(error.message));
}

async function createLocal(page: Page) {
  await page.goto(address);
  const projectInput = page.getByLabel("项目目录");
  await expect
    .poll(
      async () =>
        (await projectInput.isVisible()) ||
        (await page
          .getByRole("group", { name: source, exact: true })
          .isVisible()),
    )
    .toBe(true);
  if (await projectInput.isVisible()) {
    await projectInput.fill(source);
    await page
      .getByRole("button", { name: "使用隔离 Local", exact: true })
      .click();
  } else {
    await page
      .getByRole("group", { name: source, exact: true })
      .getByRole("button", { name: "新建隔离 Local 对话", exact: true })
      .click();
  }

  const [created] = await Promise.all([
    page.waitForResponse(
      (value) =>
        value.url().endsWith("/api/sessions") &&
        value.request().method() === "POST",
    ),
    page
      .getByRole("dialog", { name: "新建隔离 Local 对话" })
      .getByRole("button", { name: "创建隔离 Local", exact: true })
      .click(),
  ]);
  assert.equal(created.status(), 200);
  const session = (await created.json()) as Session;
  assert.equal(session.localOverlay?.state, "ready");
  assert.equal(session.localOverlay.projectWorkspace, source);
  assert.notEqual(session.workspace, source);
  assert.equal(session.worktree, undefined);
  await expect(page.getByText("隔离 Local", { exact: true })).toBeVisible();

  return session;
}

async function start(page: Page, session: Session, prompt: string) {
  await page.getByLabel("任务描述").fill(prompt);
  const button = page.getByRole("button", { name: "开始执行" });
  await expect(button).toBeEnabled();
  const [started] = await Promise.all([
    page.waitForResponse(
      (value) =>
        value.url().endsWith(`/api/sessions/${session.id}/tasks`) &&
        value.request().method() === "POST",
    ),
    button.click(),
  ]);
  assert.equal(started.status(), 200);

  return (await started.json()) as Task;
}

async function snapshot(session: Session): Promise<Snapshot> {
  const response = await context.request.get(
    `${address}/api/sessions/${session.id}`,
  );
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["cache-control"], "no-store");

  return response.json();
}

async function terminal(
  session: Session,
  task: Task,
  expected: "completed" | "failed",
  expectedView: "ready" | "failed" = "ready",
) {
  const deadline = performance.now() + 90000;
  let saved: Snapshot;
  for (;;) {
    saved = await snapshot(session);
    const status = saved.tasks.find((item) => item.id === task.id)?.status;
    if (
      status &&
      ["completed", "failed", "cancelled", "interrupted"].includes(status)
    ) {
      assert.equal(status, expected, "Unexpected terminal task status");
      break;
    }

    assert(
      performance.now() < deadline,
      "HTTP task did not finish within 90 seconds",
    );
    await delay(100);
  }

  const events = saved.events.filter((event) => event.taskId === task.id);
  assert(
    events.some(
      (event) =>
        event.type === "execution_instance" &&
        event.data.mode === "windows-sandbox-user" &&
        event.data.sandboxApplied === true &&
        event.data.state === "completed",
    ),
  );
  assert(
    !events.some(
      (event) =>
        ["sandbox_fallback", "sandbox_warning"].includes(event.type) ||
        (event.type === "execution_instance" &&
          event.data.mode === "host-process"),
    ),
  );
  assert.equal(saved.session.localOverlay?.state, expectedView);

  return saved;
}

try {
  const sessions = [await createLocal(pages[0]!), await createLocal(pages[1]!)];
  assert.notEqual(sessions[0]!.workspace, sessions[1]!.workspace);
  const tasks = [
    await start(pages[0]!, sessions[0]!, "LOCAL UI A: run fixture"),
    await start(pages[1]!, sessions[1]!, "LOCAL UI B: run fixture"),
  ];
  for (const [index, session] of sessions.entries()) {
    const saved = await terminal(session, tasks[index]!, "completed");
    assert.equal(saved.session.localOverlay?.publication?.state, "published");
    assert.equal(saved.session.localOverlay.publication.files, 1);
    const candidate = saved.events.filter(
      (event) =>
        event.type === "execution_instance" &&
        event.data.purpose === "local-validation" &&
        event.data.state === "completed",
    );
    assert.equal(candidate.length, 1);
    await expect(pages[index]!.getByText(/所选源码已发布/)).toBeVisible();
    await pages[index]!.screenshot({
      path: path.join(root, `published-${index}.png`),
      fullPage: true,
    });
  }

  const a = intervals.get("A")!;
  const b = intervals.get("B")!;
  assert(Math.max(a[0], b[0]) < Math.min(a[1], b[1]));
  for (const label of ["A", "B"]) {
    assert.equal(
      (await readFile(path.join(source, `source-${label}.txt`), "utf8")).trim(),
      `published ${label}`,
    );
    await assert.rejects(readFile(path.join(source, `bypass-${label}.txt`)), {
      code: "ENOENT",
    });
  }

  await assert.rejects(readFile(path.join(source, "runtime.txt")), {
    code: "ENOENT",
  });

  phase = "conflict";
  const conflict = await start(
    pages[0]!,
    sessions[0]!,
    "LOCAL UI A: conflicting edit",
  );
  const retained = await terminal(sessions[0]!, conflict, "failed");
  assert.equal(retained.session.localOverlay?.publication?.state, "rejected");
  await expect(pages[0]!.getByText(/来源冲突或验证未通过/)).toBeVisible();
  await pages[0]!.getByText("检查私有修改", { exact: true }).click();
  await pages[0]!.getByLabel("相对文件路径").fill("source-A.txt");
  await pages[0]!
    .getByRole("button", { name: "查看三方内容", exact: true })
    .click();
  await expect(
    pages[0]!.getByRole("region", { name: "文件检查结果" }),
  ).toContainText("private conflict");
  await expect(
    pages[0]!.getByRole("region", { name: "文件检查结果" }),
  ).toContainText("external winner");
  await pages[0]!.getByLabel("任务描述").fill("unsent draft");
  const [continuedHttp] = await Promise.all([
    pages[0]!.waitForResponse(
      (value) =>
        value
          .url()
          .endsWith(`/api/sessions/${sessions[0]!.id}/local-resolution`) &&
        value.request().method() === "POST",
    ),
    pages[0]!
      .getByRole("button", { name: "在新对话中解决", exact: true })
      .click(),
  ]);
  assert.equal(continuedHttp.status(), 200);
  const continued = (await continuedHttp.json()) as Session;
  assert.equal(continued.localOverlay?.resolution?.sessionId, sessions[0]!.id);
  assert.deepEqual(continued.localOverlay.resolution.paths, ["source-A.txt"]);
  await expect(pages[0]!.getByLabel("任务描述")).toContainText("unsent draft");
  assert.equal((await snapshot(continued)).tasks.length, 0);
  assert.equal(
    await readFile(path.join(source, "source-A.txt"), "utf8"),
    "external winner\n",
  );
  await pages[0]!.screenshot({
    path: path.join(root, "continued.png"),
    fullPage: true,
  });

  let interruption: Awaited<ReturnType<typeof interruptedBrowser>> | undefined;
  if (interrupted) {
    phase = "interrupted";
    const parent = await createLocal(pages[0]!);
    interruption = await interruptedBrowser({
      root,
      data,
      source,
      parent,
      page: pages[0]!,
      snapshot,
      start,
      terminal,
    });
  }

  const refreshed = refresh
    ? await privateRefreshBrowser({
        root,
        source,
        page: pages[0]!,
        create: () => createLocal(pages[0]!),
        snapshot,
        start,
        terminal,
        setPhase: (next) => {
          phase = next;
          calls.clear();
        },
      })
    : [];

  assert.equal(
    server.engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
    0,
  );
  await server.shutdown();
  server = await createApp(
    new Config(data, { legacy: false }),
    log,
    () => provider,
  );
  address = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const [rebootBootstrap] = await Promise.all([
    pages[0]!.waitForResponse((value) =>
      value.url().endsWith("/api/bootstrap"),
    ),
    pages[0]!.goto(address),
  ]);
  assert.equal(rebootBootstrap.status(), 200);
  const original = await snapshot(sessions[0]!);
  assert.equal(original.session.localOverlay?.publication?.state, "rejected");
  const savedContinuation = await snapshot(continued);
  assert.equal(savedContinuation.tasks.length, 0);
  assert.equal(
    savedContinuation.session.localOverlay?.resolution?.sessionId,
    sessions[0]!.id,
  );
  if (interruption) {
    const saved = await snapshot(interruption.child);
    assert.equal(saved.session.localOverlay?.resolution?.state, "interrupted");
    assert.equal(saved.session.localOverlay.publication?.state, "published");
    assert.equal(saved.tasks.length, 1);
    assert.equal(
      (await snapshot(interruption.parent)).session.localOverlay?.state,
      "active",
    );
  }

  for (const session of refreshed) {
    const saved = await snapshot(session);
    assert.equal(saved.session.localOverlay?.state, "ready");
    assert.equal(saved.tasks.length, 2);
    assert.equal(
      saved.tasks.filter((task) => task.status === "failed").length,
      1,
    );
    assert.equal(
      saved.tasks.filter((task) => task.status === "completed").length,
      1,
    );
  }

  const project = pages[0]!.getByRole("group", { name: source, exact: true });
  await expect(project).toBeVisible();
  await project
    .getByRole("button", { name: original.session.title, exact: true })
    .click();
  await expect(pages[0]!.getByText(/来源冲突或验证未通过/)).toBeVisible();
  await pages[0]!.screenshot({
    path: path.join(root, "restarted.png"),
    fullPage: true,
  });
  assert.deepEqual(pageErrors, []);
  await server.shutdown();
  const candidateEntries = await readdir(
    path.join(data, "local-overlays", "candidates"),
  );
  assert(
    !candidateEntries.some(
      (name) => name.endsWith(".access.json") || /^[a-f0-9-]{36}$/.test(name),
    ),
  );

  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    passed: true,
    settings: "private v1 settings, Sandbox enabled",
    browser: "Chromium, production UI/HTTP/SSE; no route interception",
    execution:
      "installed Windows dedicated-account Runtime IPC v18 and real WinFsp",
    commandIntervals: Object.fromEntries(intervals),
    ...(refresh
      ? {
          privateRefresh: {
            passed: true,
            cases: ["before acknowledgement", "after acknowledgement"],
            resumedSessions: refreshed.length,
            historyAfterRestart: true,
            sourceNotRewritten: true,
            unselectedPrivateRetained: true,
            noAutomaticTask: true,
          },
        }
      : {}),
    ...(interruption
      ? {
          interruptedReference: {
            passed: true,
            checks: interruption.checks,
            historyAfterRestart: true,
          },
        }
      : {}),
    checks: [
      "UI creates two isolated Local conversations",
      "real parallel Runtime and selected publication",
      "candidate Runtime and no host fallback",
      "source conflict retained and visible",
      "three-way review and fresh continuation through UI",
      "unsent draft retained; no automatic task",
      "fixture service restart preserves history and source grouping",
      "all own tasks and server drained",
      "normal candidate access records and UUID controls removed",
    ],
    limitations: [
      "fixed provider, not a real model evaluation",
      "synthetic small files, not a large project build",
      "sessions are not OS security boundaries",
      "no old dirty-volume remount or POSIX acceptance",
      ...(refresh
        ? [
            "Refresh acknowledgement loss injected around the real callback; no process or server crash",
          ]
        : []),
      ...(interruption
        ? [
            "interrupted helper/owner are real; stale active manifest/service lock are injected, not a real Runtime/server crash",
          ]
        : []),
    ],
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `LOCAL_OVERLAY_BROWSER PASS report=${path.join(root, "report.json")}\n`,
  );
} catch (error) {
  for (const [index, page] of pages.entries()) {
    await page
      .screenshot({
        path: path.join(root, `failure-${index}.png`),
        fullPage: true,
      })
      .catch(() => {});
  }

  throw error;
} finally {
  await browser.close();
  await server.shutdown();
}
