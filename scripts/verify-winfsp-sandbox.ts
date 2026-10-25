/**
 * verify-winfsp-overlay --sandbox 的产品安装态验证，使用独占 Git 来源和 Broker 数据目录。
 * 1. 内存模型要求专用账户在 overlay 写入、add/commit，核对来源 HEAD/index/文件保持独立。
 * 2. 完成必须是 windows-sandbox-user 且 clean lease release；宿主 fallback/unknown 均失败。
 * 3. 关闭 Engine 后重新打开同一会话并取消模型请求，核对挂载恢复、持久 capability 和正常取消。
 * 不安装或 Repair Sandbox、不使用真实模型/API key、不重启用户服务；失败现场保留。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { git } from "../src/worktrees/git.js";
import type { ModelProvider } from "../src/providers/model-provider.js";

async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Overlay Sandbox verification timed out")),
          60_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function assertRuntime(
  store: Store,
  sessionId: string,
  taskId: string,
  state: "completed" | "cancelled",
) {
  const events = store
    .events(sessionId)
    .filter((event) => event.taskId === taskId);
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

export async function verifyOverlaySandbox(root: string) {
  process.env.CODEATELIER_SANDBOX_ENABLED = "true";
  process.env.CODEATELIER_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.CODEATELIER_MODEL = "overlay-verification";
  process.env.CODEATELIER_API_KEY = "";
  const source = path.join(root, "sandbox-source");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Overlay fixture"]);
  await git(source, ["config", "user.email", "overlay@example.invalid"]);
  await writeFile(path.join(source, "file.txt"), "source\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  const head = await git(source, ["rev-parse", "HEAD"]);
  const index = await readFile(path.join(source, ".git", "index"));
  let calls = 0;
  const provider: ModelProvider = {
    async getCapabilities() {
      return {
        limits: { max_context_window_tokens: 64_000, max_output_tokens: 1_024 },
      };
    },
    async run(input) {
      if (calls++ === 0) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "overlay-command",
              name: "run_command",
              arguments: JSON.stringify({
                execution: { id: "probe", dependsOn: [] },
                arguments: {
                  command:
                    "whoami; Set-Content -LiteralPath 'private.txt' -Value 'runtime'; git add private.txt; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git -c commit.gpgsign=false commit -m 'overlay runtime'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Write-Output 'OVERLAY_RUNTIME_GIT_OK'",
                },
              }),
            },
          ],
        };
      }

      const output = JSON.stringify(input);
      assert.match(output, /codeateliersandbox/i);
      assert.match(output, /OVERLAY_RUNTIME_GIT_OK/);

      return { text: "verified", output: [] };
    },
  };
  const config = new Config(path.join(root, "sandbox-data"));
  config.settings.maxSteps = 3;
  const store = new Store(path.join(config.directory, "history.sqlite"));
  let engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
  );
  try {
    const session = await engine.worktrees.createRiftri(
      { id: randomUUID(), workspace: source },
      async (workspace) => store.create(workspace, "Overlay Sandbox fixture"),
    );
    const task = await engine.start(
      session.id,
      "Run the fixed local verification command.",
    );
    await bounded(engine.active!.done);
    assert.equal(store.task(task.id)?.status, "completed");
    assertRuntime(store, session.id, task.id, "completed");
    assert.equal(
      engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
      0,
    );
    assert.match(
      await readFile(path.join(session.workspace, "private.txt"), "utf8"),
      /runtime/,
    );
    await assert.rejects(readFile(path.join(source, "private.txt")), {
      code: "ENOENT",
    });
    assert.equal(await git(source, ["rev-parse", "HEAD"]), head);
    assert.deepEqual(await readFile(path.join(source, ".git", "index")), index);
    await engine.close();

    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancellation: ModelProvider = {
      getCapabilities: provider.getCapabilities,
      async run(_input, _instructions, _tools, signal) {
        entered();
        signal.throwIfAborted();

        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    };
    engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      () => cancellation,
    );
    const cancelled = await engine.start(
      session.id,
      "Wait for the fixed cancellation test.",
    );
    const done = engine.active!.done;
    await bounded(started);
    engine.cancel(cancelled.id);
    await bounded(done);
    assert.equal(store.task(cancelled.id)?.status, "cancelled");
    assertRuntime(store, session.id, cancelled.id, "cancelled");
    assert.equal(
      engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
      0,
    );
    process.stdout.write(
      "OVERLAY_SANDBOX PASS runtime=yes git=yes cleanup=yes restore=yes cancellation=yes\n",
    );
  } finally {
    await engine.close();
    await store.closeAsync();
  }
}
