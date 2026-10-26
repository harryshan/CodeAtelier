/**
 * Engine 的 Local 平台接线工厂；从启动器固定的内部 IPC 上下文同时选择挂载和候选验证实现。
 * 1. Windows/普通启动保留默认 WinFsp Service 与候选验证器，不读取 Linux 环境上下文。
 *    macOS 按 D170 暂不实现 Local overlay；即使传入完整 Linux 上下文也保持入口关闭。
 * 2. Linux 显式 namespace 上下文须完整、绝对路径规范，控制根精确绑定当前数据目录，视图根分离。
 * 3. 创建共享 Linux 控制客户端，交给 backend/候选器；真正 mount namespace 核对仍由 IPC hello 执行。
 * 4. 同时返回平台入口前提；Engine 还须要求 Sandbox。工厂不启动进程、安装 helper 或证明驱动可用。
 * 测试可指定平台并替换 Engine backend，不能由 HTTP 请求选择文件系统或反序列化执行闭包。
 */
import path from "node:path";
import type { Logger } from "pino";
import { inside } from "../tools/paths.js";
import { TraceRecorder } from "../tracing/recorder.js";
import { TraceArchive } from "../tracing/archive.js";
import type { LocalOverlayBackend } from "./backend.js";
import { CandidateValidator } from "./candidate-validator.js";
import { LinuxCandidateValidator } from "./linux-candidate.js";
import { LinuxLocalBackend } from "./linux-backend.js";
import { LinuxOverlayController } from "./linux-controller.js";

export function localOverlayPlatform(
  directory: string,
  log: Logger,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): {
  supported: boolean;
  backend?: LocalOverlayBackend;
  candidate: Pick<CandidateValidator, "validate">;
} {
  const root = path.resolve(directory, "local-overlays");
  const candidate = new CandidateValidator(path.join(root, "candidates"), log);
  if (platform !== "linux") {
    return { candidate, supported: platform === "win32" };
  }

  const socket = environment.CODEATELIER_OVERLAY_SOCKET;
  const control = environment.CODEATELIER_OVERLAY_ROOT;
  const views = environment.CODEATELIER_OVERLAY_VIEWS;
  if (!socket && !control && !views) {
    return { candidate, supported: false };
  }

  if (
    !socket ||
    !control ||
    !views ||
    ![socket, control, views].every(
      (file) => path.isAbsolute(file) && path.resolve(file) === file,
    ) ||
    control !== root ||
    socket !== path.join(root, "controller.sock") ||
    inside(path.resolve(directory), views) ||
    inside(views, path.resolve(directory))
  ) {
    throw new Error(
      "Linux Local namespace 上下文与当前数据目录不匹配；不会降级创建。",
    );
  }

  const controller = new LinuxOverlayController(
    socket,
    log,
    new TraceRecorder(),
    new TraceArchive(root, log),
  );

  return {
    supported: true,
    backend: new LinuxLocalBackend(root, controller, log, views),
    candidate: new LinuxCandidateValidator(root, controller, log, views),
  };
}
