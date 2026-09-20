/**
 * 按启动期 SandboxConfiguration 和宿主平台选择唯一允许交给 SandboxBroker 的 Runtime。
 * Engine 在构造 Broker 时调用本模块；它不执行自检、不探测 WSL，也不产生宿主副作用。真正的能力证明仍由
 * NativeWindowsSandboxRuntime.selfCheck 在每次任务首次命令的 provision 阶段完成；启动前失败由 Broker 明确切换宿主 fallback。
 *
 * 1. 开关关闭时返回 undefined，确保 V1 宿主命令路径不创建任何 Sandbox 后端。
 * 2. Windows 注册专用账户原生 Runtime；只有安装 state、二进制摘要、账户凭据和 WFP 均自检通过才执行。
 * 3. 其他平台和未来 profile 继续返回 undefined；Broker 会公开未隔离状态并走既有宿主路径，不伪造平台能力。
 */

import type { Logger } from "pino";
import type { SandboxConfiguration, SandboxRuntime } from "./types.js";
import { NativeWindowsSandboxRuntime } from "./native-windows-runtime.js";

export function createSandboxRuntime(
  configuration: SandboxConfiguration,
  platform = process.platform,
  log?: Logger,
): SandboxRuntime | undefined {
  if (!configuration.enabled || platform !== "win32") {
    return undefined;
  }

  return new NativeWindowsSandboxRuntime(process.env, undefined, log);
}
