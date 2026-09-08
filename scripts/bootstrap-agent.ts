import { approveTestCommand } from "./bootstrap/approval.js";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { Engine } from "../src/agent/engine.js";
import { Store } from "../src/sessions/store.js";
import { createLogger } from "../src/logging/logger.js";

const prepareOnly = process.argv.includes("--prepare-only");

if (!prepareOnly && !process.env.CODEATELIER_API_KEY) {
  throw new Error(
    "Set CODEATELIER_API_KEY before running this opt-in live evaluation",
  );
}

const repository = process.cwd();
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/bootstrap-"));
const workspace = path.join(root, "workspace");
const revision = execFileSync(
  "git",
  [
    "-c",
    `safe.directory=${repository.replaceAll("\\", "/")}`,
    "rev-parse",
    "HEAD",
  ],
  { encoding: "utf8" },
).trim();
const files = execFileSync(
  "git",
  [
    "-c",
    `safe.directory=${repository.replaceAll("\\", "/")}`,
    "ls-tree",
    "-r",
    "--name-only",
    revision,
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");

// 只复制提交内文件，不复制凭据、历史、Git 元数据或运行中的服务数据。
for (const file of files) {
  const target = path.join(workspace, file);
  await mkdir(path.dirname(target), { recursive: true });
  const content = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${repository.replaceAll("\\", "/")}`,
      "show",
      `${revision}:${file}`,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  await writeFile(target, content);
}

// 依赖仅供受限测试命令使用；这不是操作系统沙箱。
await symlink(
  path.join(repository, "node_modules"),
  path.join(workspace, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
const sourcePath = "src/config/config.ts";
const testPath = "tests/config.test.ts";
const docPath = "docs/development.md";
const originalTests = await readFile(path.join(workspace, testPath), "utf8");
const originalSource = await readFile(path.join(workspace, sourcePath), "utf8");
const broken = originalSource.replace(
  'parsed.settings.model = "codex/gpt-5.6-luna";',
  'parsed.settings.model = "5.6-luna";',
);
if (broken === originalSource) {
  throw new Error("Regression injection no longer matches the source");
}

await writeFile(path.join(workspace, sourcePath), broken);
const testArgs = [
  path.join(workspace, "node_modules/vitest/vitest.mjs"),
  "run",
  testPath,
  "--reporter=json",
];

function verify(label: string) {
  try {
    const output = execFileSync(process.execPath, testArgs, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60000,
      stdio: "pipe",
    });

    return { label, passed: true, output };
  } catch (error: any) {
    return {
      label,
      passed: false,
      output: String(error.stdout || error.stderr || ""),
    };
  }
}

const baseline = verify("injected regression");
await writeFile(path.join(root, "baseline.txt"), baseline.output);
if (baseline.passed || !baseline.output.includes("codex/gpt-5.6-luna")) {
  throw new Error("Baseline did not reproduce the intended regression");
}

if (prepareOnly) {
  process.stdout.write(
    JSON.stringify({ workspace, baselineFailed: true, modelCalled: false }) +
      "\n",
  );
  process.exit(0);
}

const config = new Config(path.join(root, "data"));
const log = createLogger(config.directory, "info", () => [config.apiKey]);
let store = new Store(path.join(config.directory, "history.sqlite"));
let engine = new Engine(store, config, log);
const session = store.create(workspace, "自举：配置回归修复与中断恢复");
let interrupted = false;
let approvals = 0;
const allowedFiles = new Set([sourcePath, testPath, docPath]);

function observe(current: Engine, interrupt: boolean) {
  current.events.on("change", () => {
    for (const approval of current.approvals.list()) {
      const allowed = approveTestCommand(
        approval.tool,
        approval.description,
        workspace,
        testArgs,
      );
      approvals += 1;
      log.info({ event: "bootstrap.approval", tool: approval.tool, allowed });
      current.approvals.decide(approval.id, allowed ? "once" : "deny");
    }
  });
  current.events.on("event", (event) => {
    if (event.type !== "delta") {
      log.info({
        event: "bootstrap.progress",
        type: event.type,
        tool: event.data.name,
      });
    }

    if (
      interrupt &&
      !interrupted &&
      event.type === "tool_result" &&
      event.data.name === "edit_file" &&
      !event.data.result?.error
    ) {
      interrupted = true;
      current.cancel(event.taskId);
    }
  });
}

async function wait() {
  const timer = setTimeout(() => {
    if (engine.active) {
      engine.cancel(engine.active.task.id);
    }
  }, 600000);
  try {
    await engine.active?.done;
  } finally {
    clearTimeout(timer);
  }
}

try {
  observe(engine, true);
  const task = engine.start(
    session.id,
    `这是 CodeAtelier 自己源码的隔离验收副本。遵循 AGENTS.md 和文档约定，但本次不提交或推送代码；不需要安装依赖或启动服务。配置更新存在回归：model 输入 5.6-luna 后没有规范化为 codex/gpt-5.6-luna。请先读相关代码和测试并运行测试复现，然后修复，保留全部已有测试，追加构造函数从环境变量读取简称并规范化的测试，更新 docs/development.md 的相关说明。仅修改 ${[...allowedFiles].join("、")}，使用 edit_file。唯一预授权命令的 command=${JSON.stringify(process.execPath)}，args=${JSON.stringify(testArgs)}，cwd="."；不要运行其他命令。完成后根据实际测试结果报告。`,
  );
  await wait();
  const firstStatus = store.task(task.id)?.status;
  await engine.close();
  store.close();
  store = new Store(path.join(config.directory, "history.sqlite"));
  engine = new Engine(store, config, log);
  observe(engine, false);
  if (interrupted && firstStatus === "cancelled") {
    engine.resume(
      task.id,
      "验收主动中断已结束，请读取当前文件核实进度，继续完成原任务，不重复已完成修改。",
    );
    await wait();
  }

  const generatedTests = await readFile(path.join(workspace, testPath), "utf8");
  const final = verify("agent tests");
  await writeFile(path.join(root, "agent-tests.txt"), final.output);
  // 使用原始测试独立复验，防止模型通过削弱断言获得绿灯。
  await writeFile(path.join(workspace, testPath), originalTests);
  let independent;
  try {
    independent = verify("original regression tests");
  } finally {
    await writeFile(path.join(workspace, testPath), generatedTests);
  }

  await writeFile(path.join(root, "independent-tests.txt"), independent.output);
  // 新增测试必须能杀死构造路径的变异，而不只是增加文件长度。
  const repairedSource = await readFile(
    path.join(workspace, sourcePath),
    "utf8",
  );
  const mutant = repairedSource.replace(
    'this.settings.model = "codex/gpt-5.6-luna";',
    'this.settings.model = "5.6-luna";',
  );
  let addedTestDetectsRegression = false;
  if (final.passed && independent.passed && mutant !== repairedSource) {
    await writeFile(path.join(workspace, sourcePath), mutant);
    try {
      const mutation = verify("constructor mutation");
      await writeFile(path.join(root, "mutation-tests.txt"), mutation.output);
      addedTestDetectsRegression =
        !mutation.passed && mutation.output.includes("codex/gpt-5.6-luna");
    } finally {
      await writeFile(path.join(workspace, sourcePath), repairedSource);
    }
  }

  const changed = [];
  for (const file of files) {
    const original = execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${repository.replaceAll("\\", "/")}`,
        "show",
        `${revision}:${file}`,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    if (!original.equals(await readFile(path.join(workspace, file)))) {
      changed.push(file);
    }
  }

  const tracked = new Set(files);
  async function findNewFiles(directory: string, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!relative && entry.name === "node_modules") {
        continue;
      }

      const file = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        await findNewFiles(path.join(directory, entry.name), file);
      } else if (!tracked.has(file)) {
        changed.push(file);
      }
    }
  }

  await findNewFiles(workspace);
  const events = store.events(session.id);
  const report = {
    revision,
    model: config.settings.model,
    platform: process.platform,
    workspace,
    firstStatus,
    interrupted,
    approvals,
    finalStatus: store.tasks(session.id).at(-1)?.status,
    testsPassed: final.passed,
    originalTestsPassed: independent.passed,
    addedTests:
      JSON.parse(final.output).numTotalTests >
      JSON.parse(baseline.output).numTotalTests,
    addedTestDetectsRegression,
    changed,
    unexpectedChanges: changed.filter((file) => !allowedFiles.has(file)),
    commandVerified: events.some(
      (event) =>
        event.type === "tool_result" &&
        event.data.name === "run_command" &&
        event.data.result?.exitCode === 0,
    ),
    recoveryRecorded: events.some((event) => event.type === "recovery"),
    eventCount: events.length,
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  log.info({ event: "bootstrap.result", ...report });
  if (
    !interrupted ||
    report.finalStatus !== "completed" ||
    !final.passed ||
    !independent.passed ||
    !report.addedTests ||
    !report.addedTestDetectsRegression ||
    !changed.includes(docPath) ||
    report.unexpectedChanges.length ||
    !report.commandVerified ||
    !report.recoveryRecorded
  ) {
    process.exitCode = 1;
  }
} finally {
  await engine.close();
  store.close();
}
