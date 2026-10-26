/**
 * pnpm start:overlay 的 Linux 显式启动入口，在应用 mount namespace 中运行既有服务 supervisor。
 * 1. 由 linuxOverlayStartup 校验平台/参数并生成固定产物路径；缺失构建时直接报错。
 * 2. 检查 helper 可执行及控制器/服务可读，再用 argv 启动 Python；不经 shell，不修改设置。
 * 3. SIGINT/SIGTERM 转发控制器，等待其排空服务和卸载后退出；不在未知退出后重启。
 * 应用和挂载 tracing 由现有服务/控制器负责，本入口仅输出不含正文的开始/退出/失败状态。
 * 只用于编译后的 dist；不自动安装 FUSE、启用 Sandbox、迁移历史或回退到普通 start。
 * 0. 代码总开关关闭时在路径检查/创建 namespace 或启动子进程前拒绝。
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linuxOverlayStartup } from "../local-overlays/linux-startup.js";
import { requireLocalOverlayEnabled } from "../local-overlays/readiness.js";

requireLocalOverlayEnabled();
const plan = linuxOverlayStartup(
  process.argv.slice(2),
  fileURLToPath(new URL("../../", import.meta.url)),
  process.execPath,
);
await access(plan.helper, constants.X_OK);
await access(plan.controller, constants.R_OK);
await access(plan.server, constants.R_OK);

process.stdout.write("INFO overlay.start.started\n");
const child = spawn("python3", plan.args, { stdio: "inherit" });
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.on("error", () => {
  process.stderr.write("ERROR overlay.start.failed reason=python_spawn\n");
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  process.exitCode = code ?? 1;
  process.stdout.write(`INFO overlay.start.exited code=${process.exitCode}\n`);
});
