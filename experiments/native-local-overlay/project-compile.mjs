/**
 * 真实工程编译探针的固定子命令，由 prepare-project.py 放入独占来源夹具。
 * 1. 在当前工作目录运行已有 TypeScript，对正式 server tsconfig 执行完整 emit。
 * 2. hashOutputs 对输出相对路径和正文建立摘要，直接编译与 overlay 编译使用同样目录深度。
 * 3. 写出时间、诊断、产物统计及退出码；失败保留输出，父探针核对真实 Sandbox 回执。
 * 只产生夹具内 .overlay-build 和 .overlay-build.json，不安装依赖或运行生成代码/Evaluation。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function hashOutputs(directory, relative = "", result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await hashOutputs(file, name, result);
    } else {
      if (!entry.isFile()) {
        throw new Error("Unexpected compiler output type");
      }

      const bytes = await readFile(file);
      result.push({
        path: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

const startedAt = Date.now();
const started = performance.now();
const compile = spawnSync(
  process.execPath,
  [
    "node_modules/typescript/lib/tsc.js",
    "--project",
    "tsconfig.server.json",
    "--outDir",
    ".overlay-build",
    "--incremental",
    "false",
    "--pretty",
    "false",
    "--extendedDiagnostics",
  ],
  { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
);
const compileMs = performance.now() - started;
const endedAt = Date.now();
const files = await hashOutputs(".overlay-build").catch(() => []);
const result = {
  exitCode: compile.status,
  error: compile.error?.message,
  startedAt,
  endedAt,
  compileMs,
  diagnostics: compile.stdout + compile.stderr,
  files: files.length,
  bytes: files.reduce((total, file) => total + file.bytes, 0),
  outputSha256: createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex"),
};
await writeFile(".overlay-build.json", JSON.stringify(result, null, 2) + "\n");
process.exitCode = compile.status ?? 1;
