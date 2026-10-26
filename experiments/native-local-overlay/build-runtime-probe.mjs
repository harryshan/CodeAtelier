/**
 * 手动打包原生 overlay 的 Runtime 联调与发布联调所用的当前生产代码。
 * 1. 先打包异步 SQLite host/Worker 到队列旁，供完整 HTTP 探针使用生产存储路径。
 * 2. esbuild 将 namespace 控制客户端、启动器、IPC、候选命令、POSIX 批次、Publisher 和 tracing 打入 .local。
 * 3. SDK 保持外部依赖，由实验参数指向已验证的 Linux 安装，不复制旧产品源码；project-build 测真实工程编译。
 * 4. 只生成实验产物，不运行 Runtime、不注册默认检查、不安装依赖或调用 Evaluation。
 */
import { build } from "esbuild";

// 完整 HTTP 探针保留生产异步 SQLite host/Worker，位置与打包后的队列相邻。
for (const worker of ["store-host", "store-worker"]) {
  await build({
    entryPoints: [`src/sessions/${worker}.ts`],
    outfile: `.local/${worker}.js`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
}

for (const name of [
  "runtime",
  "publish",
  "controller",
  "backend",
  "engine",
  "git-policy",
  "project-build",
]) {
  await build({
    entryPoints: [`experiments/native-local-overlay/${name}-probe.mjs`],
    outfile: `.local/posix-overlay-${name}-probe.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["@microsoft/mxc-sdk/*"],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
}
