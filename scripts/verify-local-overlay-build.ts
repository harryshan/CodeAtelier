/**
 * 手动在真实 CodeAtelier 工作树上验证候选工程类型编译及工程读集；不发布任何源码。
 * 1. 固定使用本仓库 TypeScript/tsconfig，先直接编译作为单次参考，再在新 WinFsp 候选视图执行。
 *    默认 noEmit；--emit 使用后端 tsconfig，直接产物写 TEMP，候选产物写私有目录，比较所有 JS 摘要。
 * 2. 只在私有 README 写标记，源码 lower 为原目录；临时控制根在系统 TEMP，避免与来源重叠。
 * 3. 生产 CandidateValidator 核对候选及所有原生普通文件读依赖；记录编译诊断、耗时、私有逻辑/分配字节。
 *    仅包裹当前进程的真实 start 以取得同一 Manager 的累计计数，调用后立即恢复原入口，不替换挂载行为或数据。
 * 4. 默认 executeProcess；--sandbox 改走生产候选 Runtime 计划，受保护 Node 与视图内编译器，不增加来源根。
 * 5. 两种执行路径均报告进程树排空；正常候选目录由生产生命周期回收，报告和日志保留。
 * 不安装驱动、不运行模型/Evaluation；--sandbox 要求已安装 Runtime 且无其它 Sandbox 任务，不证明外部/目录依赖完整。
 * 不清系统缓存，不把一次直接/overlay 顺序运行作为受控性能基准；不要在并发修改本工作树时运行。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../src/logging/logger.js";
import { CandidateValidator } from "../src/local-overlays/candidate-validator.js";
import { digest } from "../src/local-overlays/publication/files.js";
import { executeProcess } from "../src/tools/process.js";
import {
  OverlayManager,
  type OverlayMetrics,
} from "../src/worktrees/overlay.js";
import { runBuildInSandbox } from "./local-overlay-build-runtime.js";

assert.equal(process.platform, "win32");
const sandbox = process.argv.includes("--sandbox");
const emit = process.argv.includes("--emit");
const outputName = `.codeatelier-build-${randomUUID()}`;
assert.equal(
  JSON.parse(await readFile("package.json", "utf8")).name,
  "codeatelier",
);
const source = await realpath(process.cwd());
const root = await mkdtemp(
  path.join(os.tmpdir(), "codeatelier-overlay-build-"),
);
process.stdout.write(`LOCAL_BUILD START root=${root}\n`);
const candidates = path.join(root, "candidates");
const compiler = await realpath(
  path.join(source, "node_modules/typescript/lib/tsc.js"),
);
const original = await readFile(path.join(source, "README.md"));
const marker = Buffer.concat([
  original,
  Buffer.from("\n<!-- private build verification -->\n"),
]);
const signal = AbortSignal.timeout(emit ? 600_000 : 300_000);
const validator = new CandidateValidator(
  candidates,
  createLogger(root, "info"),
);

function diagnostics(output: string) {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^(Files|Lines of TypeScript|Memory used|I\/O Read time|I\/O Write time|ResolveModule time|Emit time|Total time):\s+(.+)$/.exec(
        line,
      );
    if (match) {
      result[match[1]!] = match[2]!.trim();
    }
  }

  return result;
}

function compilerArguments(workspace: string, output: string) {
  return [
    ...(emit ? ["--outDir", output] : ["--noEmit"]),
    "--incremental",
    "false",
    "--pretty",
    "false",
    "--extendedDiagnostics",
    "--project",
    path.join(workspace, emit ? "tsconfig.server.json" : "tsconfig.json"),
  ];
}

async function generated(directory: string) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  assert(entries.length < 5000, "Unexpected build output size");
  const files = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), "Generated link not expected");
    if (entry.isFile()) {
      const absolute = path.join(entry.parentPath, entry.name);
      const bytes = await readFile(absolute);
      files.push({
        path: path.relative(directory, absolute).replaceAll("\\", "/"),
        bytes: bytes.length,
        hash: digest(bytes),
      });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function compile(
  workspace: string,
  label: string,
  currentSignal: AbortSignal,
) {
  const start = performance.now();
  const result = await executeProcess(
    process.execPath,
    [
      compiler,
      ...compilerArguments(
        workspace,
        label === "direct"
          ? path.join(root, "direct-output")
          : path.join(workspace, outputName),
      ),
    ],
    workspace,
    currentSignal,
    emit ? 540_000 : 180_000,
    4 * 1024 * 1024,
    () => {},
  );
  const elapsedMs = performance.now() - start;
  await writeFile(path.join(root, `${label}.log`), result.output);
  assert.equal(result.exitCode, 0, `Compiler failed; see ${label}.log`);
  assert.equal(result.truncated, false);

  return {
    elapsedMs,
    diagnostics: diagnostics(result.output),
    exitCode: result.exitCode,
  };
}

async function footprint(control: string) {
  const input = path.join(root, "disk-input.json");
  await writeFile(input, JSON.stringify([control]));
  const result = await executeProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(source, "scripts/measure-worktree-disk.ps1"),
      "-InputFile",
      input,
    ],
    root,
    signal,
    60_000,
    65536,
    () => {},
  );
  assert.equal(result.exitCode, 0);

  return JSON.parse(result.output.trim()) as {
    files: number;
    logicalBytes: number;
    allocatedBytes: number;
  };
}

const baseline = await compile(source, "direct", signal);
const baselineFiles = emit
  ? await generated(path.join(root, "direct-output"))
  : [];
const nativeStart = OverlayManager.prototype.start;
let mounted: { manager: OverlayManager; id: string } | undefined;
let creationMetrics: OverlayMetrics | undefined;
let compiledMetrics: OverlayMetrics | undefined;
OverlayManager.prototype.start = async function (...args) {
  try {
    await nativeStart.apply(this, args);
    mounted = { manager: this, id: args[0] };
    creationMetrics = await this.metrics(args[0]);
  } finally {
    OverlayManager.prototype.start = nativeStart;
  }
};

const started = performance.now();
let overlay:
  | (Omit<Awaited<ReturnType<typeof compile>>, "exitCode"> & {
      exitCode: number | null;
    })
  | undefined;
let privateDisk: Awaited<ReturnType<typeof footprint>> | undefined;
let observations = 0;
let executorFinished = 0;
let sandboxProof:
  Awaited<ReturnType<typeof runBuildInSandbox>>["terminal"] | undefined;
let outputSummary:
  { files: number; bytes: number; matchingJavaScript: number } | undefined;
const receipt = await validator.validate(
  source,
  new Map([["README.md", marker]]),
  async (workspace, currentSignal) => {
    assert.deepEqual(await readFile(path.join(workspace, "README.md")), marker);
    let execution = {
      exitCode: 0 as number | null,
      drained: true,
      sandboxApplied: false,
    };
    if (sandbox) {
      const result = await runBuildInSandbox(
        root,
        workspace,
        compilerArguments(workspace, path.join(workspace, outputName)),
        currentSignal,
      );
      await writeFile(path.join(root, "overlay.log"), result.output);
      execution = result.execution;
      sandboxProof = result.terminal;
      overlay = {
        elapsedMs: result.elapsedMs,
        diagnostics: diagnostics(result.output),
        exitCode: result.execution.exitCode,
      };
    } else {
      overlay = await compile(workspace, "overlay", currentSignal);
    }

    if (emit && execution.exitCode === 0) {
      const candidateFiles = await generated(path.join(workspace, outputName));
      assert.deepEqual(
        candidateFiles.map((file) => file.path),
        baselineFiles.map((file) => file.path),
      );
      assert(
        candidateFiles.every((file) => file.bytes > 0),
        "Empty emitted file",
      );
      const javascript = candidateFiles.filter((file) =>
        file.path.endsWith(".js"),
      );
      assert(javascript.length > 100, "Must exercise real backend output");
      assert.deepEqual(
        javascript,
        baselineFiles.filter((file) => file.path.endsWith(".js")),
        "Emitted JavaScript differs from direct build",
      );
      outputSummary = {
        files: candidateFiles.length,
        bytes: candidateFiles.reduce((sum, file) => sum + file.bytes, 0),
        matchingJavaScript: javascript.length,
      };
      await assert.rejects(readdir(path.join(source, outputName)), {
        code: "ENOENT",
      });
    }

    assert(mounted);
    compiledMetrics = await mounted.manager.metrics(mounted.id);
    assert.deepEqual(await readFile(path.join(source, "README.md")), original);
    const volumes = (await readdir(candidates, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name),
    );
    assert.equal(volumes.length, 1);
    const control = path.join(candidates, volumes[0]!.name);
    const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
      readOnly: true,
    });
    try {
      observations = Number(
        db.prepare("SELECT count(*) AS n FROM observations").get()?.n,
      );
    } finally {
      db.close();
    }

    privateDisk = await footprint(control);
    executorFinished = performance.now();

    return execution;
  },
  signal,
  sandbox,
);
const completed = performance.now();
assert(receipt.reads.length > 100, "Must exercise the old PoC limit");
assert.deepEqual(await readFile(path.join(source, "README.md")), original);
assert(
  !(await readdir(candidates, { withFileTypes: true })).some(
    (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name),
  ),
  "Successful candidate must be cleaned",
);
const report = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  executionMode: sandbox ? "windows-sandbox-user" : "host-process",
  sandboxProof,
  passed: true,
  project: "CodeAtelier current working tree",
  command: emit
    ? "TypeScript tsconfig.server.json --outDir private --incremental false --extendedDiagnostics"
    : "TypeScript --noEmit --incremental false --extendedDiagnostics",
  baseline,
  overlay,
  candidateTotalMs: completed - started,
  receiptAndCleanupMs: completed - executorFinished,
  observations,
  creationMetrics,
  compiledMetrics,
  receiptReads: receipt.reads.length,
  privateDisk,
  outputSummary,
  selectedSourceUnchanged:
    digest(original) === digest(await readFile(path.join(source, "README.md"))),
  checks: [
    "actual project compiles directly and in candidate",
    "more than 100 native read dependencies verified",
    "private marker and compiler outputs never published",
    "successful candidate control removed",
  ],
  limitations: [
    sandbox
      ? "Sandbox duration includes Runtime startup/shutdown; direct baseline is host"
      : "host execution, not Sandbox",
    "single sequential run, uncontrolled OS cache",
    "external compiler/package reads and directory/absence tracking incomplete",
    emit
      ? "TypeScript backend only, not Vite/native build or execution of generated server; source maps have different relative source roots and only their presence/size was checked"
      : "not a model evaluation or emitted production build",
  ],
};
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(
  `LOCAL_BUILD PASS report=${path.join(root, "report.json")}\n`,
);
