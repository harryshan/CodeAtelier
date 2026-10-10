/**
 * 解析仅在服务启动时读取的 Sandbox 环境开关，供 Config 和 SandboxBroker 共用。
 * 它不读取 settings.json，也不选择或伪造平台隔离后端；实际后端能力由 Broker 在命令前自检。
 *
 * 1. sandboxConfiguration 严格接受未设置、true 或 false，并为浏览器准备不含敏感信息的初始状态。
 * 2. 未设置或 false 表示保留 V1 宿主执行，状态明确标为 non-isolated。
 * 3. true 在 Windows/Linux/macOS 请求对应平台后端；不支持的平台拒绝启动配置，不能静默取消用户的隔离请求。
 * 4. true 只表示请求，Broker 启动后才标为 sandboxed；Windows 保留原 fallback，MXC 失败关闭。
 *
 * 非法值会在服务构造 Config 时立即失败；运行中环境变化不会改写已经创建的配置。
 */

import type { SandboxConfiguration } from "./types.js";

export const SANDBOX_ENABLED_ENVIRONMENT = "CODEATELIER_SANDBOX_ENABLED";

export function sandboxConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): SandboxConfiguration {
  const raw = environment[SANDBOX_ENABLED_ENVIRONMENT];

  if (raw === undefined || raw === "" || raw === "false") {
    return {
      enabled: false,
      initialStatus: {
        enabled: false,
        requested: false,
        applied: false,
        mode: "non-isolated",
        platform,
        level: null,
        reason: "Sandbox 已关闭；命令按现有 V1 宿主权限执行。",
      },
    };
  }

  if (raw === "true") {
    if (!["win32", "linux", "darwin"].includes(platform)) {
      throw new Error(
        "当前平台没有 Sandbox 后端；如需宿主执行请显式关闭 Sandbox。",
      );
    }

    return {
      enabled: true,
      initialStatus: {
        enabled: true,
        requested: true,
        applied: false,
        mode: "unknown",
        platform,
        level: null,
        reason: "尚未配置并验证当前平台的 sandbox runtime。",
      },
    };
  }

  throw new Error(
    `${SANDBOX_ENABLED_ENVIRONMENT} 只能为 true 或 false；未设置时默认关闭。`,
  );
}
