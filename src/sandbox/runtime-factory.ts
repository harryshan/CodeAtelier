/**
 * 按启动期 SandboxConfiguration 和宿主平台选择唯一允许交给 SandboxBroker 的 Runtime。
 * Engine 在构造 Broker 时调用本模块；它不执行自检、不探测 WSL，也不产生宿主副作用。真正的能力证明仍由
 * WslInspectRuntime.selfCheck 在每次命令的 provision 阶段完成，失败后 Broker 保持 unknown 且拒绝执行。
 *
 * 1. 开关关闭时返回 undefined，确保 V1 宿主命令路径不创建任何 Sandbox 后端。
 * 2. 当前仅 Windows 注册 WSL2 bubblewrap 的 inspect 参考实现；它使用 Linux 内核能力，但不等同于原生
 *    Windows AppContainer/Job Object 隔离。
 * 3. 其他平台和未来 profile 继续返回 undefined，保留默认拒绝而不是猜测平台能力或降级宿主执行。
 */

import type { SandboxConfiguration, SandboxRuntime } from "./types.js";
import { WslInspectRuntime } from "./wsl-inspect-runtime.js";

export function createSandboxRuntime(
  configuration: SandboxConfiguration,
  platform = process.platform,
): SandboxRuntime | undefined {
  if (!configuration.enabled || platform !== "win32") {
    return undefined;
  }

  return new WslInspectRuntime();
}
