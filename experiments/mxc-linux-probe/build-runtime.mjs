/**
 * 手动打包 Linux IPC 实验的真实 Runtime、Worker 和 Broker fixture，不安装产品后端。
 * 1. 固定入口使用生产统一流生命周期；三个 Worker 单独输出，保留运行时相对 URL。
 * 2. Broker fixture 复用生产 gateway/session/trace，但用内存 session 和确定性模型，不接真实凭据。
 * 3. 仅写 .local/mxc-runtime-bundle，再由操作者复制到 Linux 原生目录；不改变 Windows 构建或根依赖。
 */

import path from "node:path";
import { build } from "esbuild";

const entries = {
  "agent-runtime": "tests/fixtures/agent-runtime-stream-child.ts",
  "read-file-worker": "src/tools/read-file-worker.ts",
  "compaction-worker": "src/context/compaction-worker.ts",
  "subagent-worker": "src/agent/subagent-worker.ts",
  "broker-fixture": "tests/fixtures/runtime-stream-broker.ts",
};
for (const [name, source] of Object.entries(entries)) {
  await build({
    entryPoints: [source],
    outfile: path.resolve(".local/mxc-runtime-bundle", `${name}.mjs`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
}

process.stdout.write("MXC_RUNTIME_BUNDLE PASS\n");
