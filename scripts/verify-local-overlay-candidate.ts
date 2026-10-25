/**
 * 手动验证一次性候选工程与已安装 Windows Sandbox；使用生产 Validator、Publisher 和 Engine。
 * 1. 独占普通来源夹具构造 B/O/T 的不同行修改，验证真正合并结果及未选产物隔离。
 * 2. 固定内存 provider 只请求一条普通 run_command；真实专用账户执行，不改 Runtime/ACL/IPC。
 * 3. 测试非零退出、测试改写候选、新读依赖失效、卸载后依赖失效与运行中取消，均不得发布。
 * 4. 检查正常候选目录回收、真实执行/排空和无 fallback，保存可审计报告；异常现场保留。
 * 此脚本的 Engine 执行适配器仅供验证，尚未接入产品任务/模型选择；不安装、Repair 或运行 Evaluation。
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { createLogger } from "../src/logging/logger.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { CandidateValidator } from "../src/local-overlays/candidate-validator.js";
import { Publisher } from "../src/local-overlays/publication/publisher.js";
import { EditSession } from "../src/local-overlays/publication/session.js";
import { sourceIdentity } from "../src/local-overlays/publication/files.js";

assert.equal(process.platform, "win32");
process.env.CODEATELIER_SANDBOX_ENABLED = "true";
process.env.CODEATELIER_BASE_URL = "http://127.0.0.1:1/v1";
process.env.CODEATELIER_MODEL = "candidate-verification";
process.env.CODEATELIER_API_KEY = "";
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-candidate-"));
const source = path.join(root, "source");
await mkdir(source);
await mkdir(path.join(source, ".git"));
await writeFile(path.join(source, ".git", "sentinel"), "private metadata");
const original = "$a = 1\n$b = 2\nWrite-Output ($a + $b)\n";
const ours = original.replace("$a = 1", "$a = 10");
const theirs = original.replace("$b = 2", "$b = 20");
const expected = ours.replace("$b = 2", "$b = 20");
const log = createLogger(root, "info");
const config = new Config(path.join(root, "data"));
config.settings.maxSteps = 3;
const store = new Store(path.join(config.directory, "history.sqlite"));
let command = "";
let calls = 0;
const provider: ModelProvider = {
  async getCapabilities() {
    return {
      limits: { max_context_window_tokens: 64_000, max_output_tokens: 1_024 },
    };
  },
  async run() {
    if (calls++ === 0) {
      return {
        text: "",
        output: [
          {
            type: "function_call",
            call_id: "candidate-command",
            name: "run_command",
            arguments: JSON.stringify({
              execution: { id: "candidate-command", dependsOn: [] },
              arguments: { command },
            }),
          },
        ],
      };
    }

    return { text: "Validation command finished", output: [] };
  },
};
const engine = new Engine(store, config, log, () => provider);
const candidates = path.join(root, "candidates");
const validator = new CandidateValidator(candidates, log);
const publisher = new Publisher(path.join(root, "publisher"), log);
const executions: {
  taskId: string;
  status: string;
  exitCode: number | null;
}[] = [];

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 90_000;
  while (!(await predicate())) {
    assert(performance.now() < deadline, "Candidate verification timed out");
    await delay(100);
  }
}

async function execute(workspace: string, signal: AbortSignal) {
  signal.throwIfAborted();
  calls = 0;
  const session = store.create(workspace, "Candidate validation fixture");
  const task = await engine.start(
    session.id,
    "Execute the fixed candidate validation command.",
  );
  const cancel = () => engine.cancel(task.id);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }

  try {
    await until(async () => !(await engine.hasActiveTasks()));
    const status = store.task(task.id)!.status;
    const events = store
      .events(session.id)
      .filter((event) => event.taskId === task.id);
    const terminal = events.find(
      (event) =>
        event.type === "execution_instance" &&
        ["completed", "cancelled"].includes(event.data.state),
    );
    assert(terminal, "No confirmed Runtime termination");
    assert.equal(terminal.data.mode, "windows-sandbox-user");
    assert.equal(terminal.data.sandboxApplied, true);
    assert(
      !events.some(
        (event) =>
          ["sandbox_fallback", "sandbox_warning"].includes(event.type) ||
          (event.type === "execution_instance" &&
            event.data.state === "unknown"),
      ),
    );
    const result = events.find(
      (event) =>
        event.type === "tool_result" && event.data.name === "run_command",
    )?.data.result;
    const exitCode =
      status === "completed" && typeof result?.exitCode === "number"
        ? result.exitCode
        : null;
    executions.push({ taskId: task.id, status, exitCode });
    assert.equal(
      engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount,
      0,
    );

    return { drained: true, sandboxApplied: true, exitCode };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function batch() {
  await writeFile(path.join(source, "module.ps1"), original);
  await writeFile(path.join(source, "dep.txt"), "dependency");
  await writeFile(path.join(source, "gone.txt"), "remove");
  await unlink(path.join(source, "new.txt")).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  const session = new EditSession(await sourceIdentity(source));
  await session.read("module.ps1");
  await session.edit("module.ps1", Buffer.from(ours));
  await session.read("artifact.txt");
  await session.edit("artifact.txt", Buffer.from("private artifact"));
  await session.read("gone.txt");
  await session.edit("gone.txt", null);
  await session.read("new.txt");
  await session.edit("new.txt", Buffer.from("created"));
  await writeFile(path.join(source, "module.ps1"), theirs);

  const sealed = session.seal();

  return {
    ...sealed,
    changes: sealed.changes.filter((change) => change.path !== "artifact.txt"),
  };
}

const forbidden = path.join(source, "bypass.txt").replaceAll("'", "''");
const validateCommand = [
  "$ErrorActionPreference = 'Stop'",
  "whoami",
  "if ((. .\\module.ps1) -ne 30) { throw 'Wrong merged result' }",
  "if ((Get-Content -LiteralPath 'dep.txt' -Raw) -ne 'dependency') { throw 'Wrong dependency' }",
  "if ((Test-Path -LiteralPath 'gone.txt') -or ((Get-Content -LiteralPath 'new.txt' -Raw) -ne 'created')) { throw 'Wrong candidate existence' }",
  "if ((Test-Path -LiteralPath 'artifact.txt') -or (Test-Path -LiteralPath '.git')) { throw 'Unselected or metadata exposed' }",
  `$denied = $false; try { Set-Content -LiteralPath '${forbidden}' -Value 'bad' } catch { $denied = $true }; if (-not $denied) { throw 'Source write allowed' }`,
  "Set-Content -LiteralPath 'generated.txt' -Value 'candidate-only'",
].join("; ");

try {
  command = validateCommand;
  const success = await publisher.publish(await batch(), {
    nativeWindows: true,
    validate: (files, signal) =>
      validator.validate(source, files, execute, signal!),
  });
  assert.equal(
    await readFile(path.join(source, "module.ps1"), "utf8"),
    expected,
  );
  assert.equal(await readFile(path.join(source, "new.txt"), "utf8"), "created");
  await assert.rejects(readFile(path.join(source, "gone.txt")), {
    code: "ENOENT",
  });
  const journal = JSON.parse(
    await readFile(path.join(success.directory, "journal.json"), "utf8"),
  );
  assert(
    journal.validation.reads.some(
      (read: { path: string }) => read.path === "dep.txt",
    ),
  );

  for (const mode of [
    "exit",
    "rewrite",
    "stale-during",
    "stale-after",
    "cancel",
  ] as const) {
    const controller = new AbortController();
    const current = await batch();
    command =
      validateCommand +
      (mode === "exit"
        ? "; exit 7"
        : mode === "rewrite"
          ? "; Set-Content -LiteralPath 'module.ps1' -Value 'repaired'"
          : mode === "cancel"
            ? "; Set-Content -LiteralPath 'started.txt' -Value 'started'; Start-Sleep -Seconds 60; Set-Content -LiteralPath 'late.txt' -Value 'bad'"
            : "");
    const result = publisher.publish(current, {
      nativeWindows: true,
      signal: controller.signal,
      validate: async (files, signal) => {
        const receipt = await validator.validate(
          source,
          files,
          async (workspace, candidateSignal) => {
            const running = execute(workspace, candidateSignal);
            if (mode === "cancel") {
              await until(async () =>
                readFile(path.join(workspace, "started.txt")).then(
                  () => true,
                  () => false,
                ),
              );
              controller.abort(new Error("Candidate cancelled by fixture"));
            }

            const execution = await running;
            if (mode === "stale-during") {
              await writeFile(
                path.join(source, "dep.txt"),
                "external during validation",
              );
            }

            return execution;
          },
          signal!,
        );
        if (mode === "stale-after") {
          await writeFile(
            path.join(source, "dep.txt"),
            "external after teardown",
          );
        }

        return receipt;
      },
    });
    await assert.rejects(result, (error: any) => {
      assert.equal(error.outcome, "unapplied");
      if (mode.startsWith("stale")) {
        assert.equal(error.reason, "STALE_VALIDATION_DEPENDENCY");
      }

      return true;
    });
    assert.equal(
      await readFile(path.join(source, "module.ps1"), "utf8"),
      theirs,
    );
    assert.equal(
      await readFile(path.join(source, "gone.txt"), "utf8"),
      "remove",
    );
    await assert.rejects(readFile(path.join(source, "new.txt")), {
      code: "ENOENT",
    });
  }

  assert.equal(
    (await readdir(candidates)).filter((name) => /^[0-9a-f-]{36}$/i.test(name))
      .length,
    0,
  );
  for (const file of [
    "artifact.txt",
    "generated.txt",
    "bypass.txt",
    "late.txt",
  ]) {
    await assert.rejects(readFile(path.join(source, file)), { code: "ENOENT" });
  }

  const isolated = new Map([["module.ps1", Buffer.from(expected)]]);
  await assert.rejects(
    validator.validate(
      source,
      isolated,
      async () => ({ drained: true, sandboxApplied: false, exitCode: 0 }),
      AbortSignal.timeout(30_000),
    ),
    /CANDIDATE_VALIDATION_FAILED/,
  );
  assert.equal(
    (await readdir(candidates)).filter((name) => /^[0-9a-f-]{36}$/i.test(name))
      .length,
    0,
  );
  await assert.rejects(
    validator.validate(
      source,
      isolated,
      async () => ({ drained: false, sandboxApplied: true, exitCode: 0 }),
      AbortSignal.timeout(30_000),
    ),
    /排空未确认/,
  );
  assert.equal(
    (await readdir(candidates)).filter((name) => /^[0-9a-f-]{36}$/i.test(name))
      .length,
    1,
  );

  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    validation:
      "merged candidate executed in installed dedicated-account Runtime",
    selectedResult: 30,
    selectedCreateDelete: "candidate and source existence checked",
    unselectedFiles: "absent",
    sourceAbsoluteWrite: "denied",
    gitMetadata: "hidden",
    newReadDependencies: "captured and rechecked after teardown",
    nonzeroExit: "rejected",
    validatorSourceRewrite: "rejected",
    cancellation: "drained without publication",
    normalCandidateControlDirectoriesRemaining: 0,
    injectedUnconfirmedExecution:
      "one private control retained; no command launched",
    injectedHostReceipt: "rejected as sandbox validation; no command launched",
    fallback: false,
    executions,
    limitations: [
      "Trusted verifier execution adapter, not yet a product validation-command API",
      "Directory, absent-path and external reads are not a complete transaction dependency set",
    ],
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `LOCAL_CANDIDATE PASS ${path.join(root, "report.json")}\n`,
  );
} finally {
  await engine.close();
  store.close();
}
