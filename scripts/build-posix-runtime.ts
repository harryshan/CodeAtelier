/**
 * 构建 Linux/macOS MXC 使用的固定纯 JS Runtime bundle；不运行 Sandbox、不安装系统组件。
 * 1. 将 POSIX 入口与三个 Worker 打包为 Node 24/26 兼容 ESM，Worker 文件名保持生产相对 URL 契约。
 * 2. 为四个输出生成固定 SHA-256 manifest，启动器核对后复制为逐任务只读快照。
 * 3. 产物写入 dist/runtime/posix；同一 bundle 供 Linux 与 macOS 使用，构建成功不代表 Mac 实机验证。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const output = path.resolve("dist/runtime/posix");
const entries = {
  "agent-runtime.mjs": "src/sandbox/agent-runtime-posix-main.ts",
  "compaction-worker.mjs": "src/context/compaction-worker.ts",
  "read-file-worker.mjs": "src/tools/read-file-worker.ts",
  "subagent-worker.mjs": "src/agent/subagent-worker.ts",
};
const files: Record<string, string> = {};
await mkdir(output, { recursive: true });
for (const [name, entry] of Object.entries(entries)) {
  const outfile = path.join(output, name);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
  });
  files[name] = createHash("sha256")
    .update(await readFile(outfile))
    .digest("hex");
}

await writeFile(
  path.join(output, "runtime.manifest.json"),
  JSON.stringify({ version: 1, nodeMajor: 24, files }, null, 2) + "\n",
);
process.stdout.write("POSIX_SANDBOX_RUNTIME_BUILD PASS\n");
