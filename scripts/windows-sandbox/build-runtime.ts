/**
 * 构建供 Windows Sandbox 安装器复制到受保护 ProgramData 目录的 Agent Runtime JavaScript bundle。
 * 本脚本只生成可再生构建产物，不安装账户、ACL、WFP、服务或机器级状态；native Supervisor 后续只允许启动安装状态中记录摘要的固定文件。
 *
 * 1. esbuild 将固定 Agent Runtime 入口及其生产依赖打成单个 Node 24 ESM 文件，避免运行时读取开发仓库或 pnpm symlink 图。
 * 2. 上下文压缩 Worker 单独打包，以保留 worker_threads 的进程内隔离和相对 URL 启动语义。
 * 3. 对两个输出计算 SHA-256 并原子写入严格 manifest；安装器必须重新核对摘要后才能复制。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const outputRoot = path.resolve("dist/runtime/windows-x64");
const entryOutput = path.join(outputRoot, "agent-runtime.mjs");
const workerOutput = path.join(outputRoot, "compaction-worker.mjs");
const manifestOutput = path.join(outputRoot, "runtime.manifest.json");

async function bundle(entryPoint: string, outfile: string) {
  await build({
    entryPoints: [path.resolve(entryPoint)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
}

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

await mkdir(outputRoot, { recursive: true });
await bundle("src/sandbox/agent-runtime-main.ts", entryOutput);
await bundle("src/context/compaction-worker.ts", workerOutput);

const manifest = {
  version: 1,
  nodeMajor: 24,
  entry: {
    file: path.basename(entryOutput),
    sha256: await sha256(entryOutput),
  },
  worker: {
    file: path.basename(workerOutput),
    sha256: await sha256(workerOutput),
  },
};
const temporaryManifest = `${manifestOutput}.${process.pid}.tmp`;
await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
await rename(temporaryManifest, manifestOutput);
process.stdout.write(`SANDBOX_RUNTIME_BUILD PASS output=${outputRoot}\n`);
