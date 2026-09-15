/**
 * 在临时仓库副本中放入一个已知错误，用真实模型检查修复和中断恢复。
 * 手动执行时复用生产 Engine 和 Store，最终保存验收报告及测试输出。
 *
 * 1. 检查环境和 prepare-only 选项，复制 Git 管理的文件并接入开发依赖。
 * 2. 在配置代码中注入错误，先用独立测试确认能够复现。
 * 3. 只批准指定测试命令，观察任务事件；按条件中断后，重建存储并恢复任务。
 * 4. 运行模型生成的测试和原有独立测试，再通过变异检查及改动文件列表核对修复。
 * 5. 导出结果，最后关闭引擎和数据库。
 *
 * 会修改临时副本并可能消耗真实模型用量，只能手动运行，不能放进默认检查。
 */

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

// 复用依赖供指定测试命令运行；临时副本本身不提供操作系统隔离。
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
  "parsed.settings.baseUrl = parsed.settings.baseUrl",
  'parsed.settings.baseUrl = ""',
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
// run_command 只接受一条命令文本；JSON 字符串引号能让该固定命令中的路径在常见 shell 中保持完整。
const testCommand = [process.execPath, ...testArgs]
  .map((part) => JSON.stringify(part))
  .join(" ");

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
if (baseline.passed || !baseline.output.includes("http://localhost:8888/v1")) {
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
        testCommand,
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
      event.data.name === "edit_files" &&
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
    `这是 CodeAtelier 自己源码的隔离验收副本。遵循 AGENTS.md 和文档约定，但本次不提交或推送代码；不需要安装依赖或启动服务。配置更新存在回归：baseUrl 输入 http://localhost:8888/v1/responses/ 后没有规范化为 http://localhost:8888/v1。请先读相关代码和测试并运行测试复现，然后修复，保留全部已有测试，追加构造函数从环境变量读取带 responses 后缀端点并规范化的测试，更新 docs/development.md 的相关说明。仅修改 ${[...allowedFiles].join("、")}，使用 edit_files（单文件修改也传一个 files 条目）。唯一预授权命令只传 command 字段，值必须精确为 ${JSON.stringify(testCommand)}；工作目录和 shell 由执行器内部固定，不要运行其他命令。完成后根据实际测试结果报告。`,
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
  // 再跑一次原始测试，防止模型改弱了测试却被误认为修复成功。
  await writeFile(path.join(workspace, testPath), originalTests);
  let independent;
  try {
    independent = verify("original regression tests");
  } finally {
    await writeFile(path.join(workspace, testPath), generatedTests);
  }

  await writeFile(path.join(root, "independent-tests.txt"), independent.output);
  // 把构造器改错后，新增测试应当失败，才能说明它确实检查了这条路径。
  const repairedSource = await readFile(
    path.join(workspace, sourcePath),
    "utf8",
  );
  const mutant = repairedSource.replace(
    "this.settings.baseUrl = this.settings.baseUrl",
    'this.settings.baseUrl = ""',
  );
  let addedTestDetectsRegression = false;
  if (final.passed && independent.passed && mutant !== repairedSource) {
    await writeFile(path.join(workspace, sourcePath), mutant);
    try {
      const mutation = verify("constructor mutation");
      await writeFile(path.join(root, "mutation-tests.txt"), mutation.output);
      addedTestDetectsRegression =
        !mutation.passed && mutation.output.includes("api.example.com/v1");
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
