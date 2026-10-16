/**
 * 按启动期 SandboxConfiguration 和宿主平台选择唯一允许交给 SandboxBroker 的 Runtime。
 * Engine 在构造 Broker 时调用本模块；它不执行自检、不探测 WSL，也不产生宿主副作用。真正的能力证明仍由
 * 平台 Runtime 在每次任务启动前完成；Windows 保留原 fallback，MXC 后端失败关闭。
 *
 * 1. 开关关闭时返回 undefined，确保 V1 宿主命令路径不创建任何 Sandbox 后端。
 * 2. Windows 注册专用账户原生 Runtime；只有安装 state、二进制摘要、账户凭据和 WFP 均自检通过才执行。
 * 3. Linux/macOS 注册 MXC 私有流启动器，SDK 只在实际任务时动态加载；其他平台不注册后端。
 * 4. 额外授权根从 Config 固定的启动投影读取（旧调用方可提供环境）；非法/相对路径拒绝，不热改活动实例。
 */

import type { Logger } from "pino";
import type { SandboxConfiguration, SandboxRuntime } from "./types.js";
import { NativeWindowsSandboxRuntime } from "./native-windows-runtime.js";
import type { TraceRecorder } from "../tracing/recorder.js";
import path from "node:path";
import { dataDirectory } from "../config/data-directory.js";
import { MxcSandboxRuntime } from "./mxc-runtime.js";

function configuredRoots(name: string, environment: NodeJS.ProcessEnv) {
  const raw = environment[name];
  if (!raw) {
    return [];
  }

  const roots: unknown = JSON.parse(raw);
  if (
    !Array.isArray(roots) ||
    !roots.every(
      (root) =>
        typeof root === "string" &&
        path.isAbsolute(root) &&
        !root.includes("\0"),
    )
  ) {
    throw new Error(`${name} 必须是绝对目录路径的 JSON 数组。`);
  }

  return roots as string[];
}

export function createSandboxRuntime(
  configuration: SandboxConfiguration,
  platform = process.platform,
  log?: Logger,
  traces?: TraceRecorder,
  brokerDataDirectory = dataDirectory(),
  environment: NodeJS.ProcessEnv = process.env,
): SandboxRuntime | undefined {
  if (!configuration.enabled) {
    return undefined;
  }

  if (platform === "win32") {
    return new NativeWindowsSandboxRuntime(environment, undefined, log, traces);
  }

  if (platform === "linux" || platform === "darwin") {
    return new MxcSandboxRuntime({
      platform,
      dataDirectory: brokerDataDirectory,
      log,
      traces,
      readRoots: configuredRoots("CODEATELIER_SANDBOX_READ_ROOTS", environment),
      writeRoots: configuredRoots(
        "CODEATELIER_SANDBOX_WRITE_ROOTS",
        environment,
      ),
    });
  }

  return undefined;
}
