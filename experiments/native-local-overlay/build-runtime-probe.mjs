/**
 * 手动打包原生 overlay 的 Runtime 联调与发布联调所用的当前生产代码。
 * 1. esbuild 将启动器、IPC、候选命令、POSIX 批次、Publisher 和 tracing 打入 .local。
 * 2. SDK 保持外部依赖，由实验参数指向已验证的 Linux 安装，不复制旧产品源码。
 * 3. 只生成实验产物，不运行 Runtime、不注册默认检查、不安装依赖或调用 Evaluation。
 */
import { build } from "esbuild";

for (const name of ["runtime", "publish"]) {
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
