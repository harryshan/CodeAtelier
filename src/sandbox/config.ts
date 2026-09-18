/**
 * 解析仅在服务启动时读取的 Sandbox 环境开关，供 Config 和 SandboxBroker 共用。
 * 它不读取 settings.json，也不选择或伪造平台隔离后端；实际后端能力由 Broker 在命令前自检。
 *
 * 1. sandboxConfiguration 严格接受未设置、true 或 false，并为浏览器准备不含敏感信息的初始状态。
 * 2. 未设置或 false 表示保留 V1 宿主执行，状态明确标为 non-isolated。
 * 3. true 表示请求隔离但尚未证明运行时可用，初始状态必须是 unknown，避免启动时错误宣称已隔离。
 *
 * 非法值会在服务构造 Config 时立即失败；运行中环境变化不会改写已经创建的配置。
 */

import type { SandboxConfiguration } from "./types.js";

export const SANDBOX_ENABLED_ENVIRONMENT = "CODEATELIER_SANDBOX_ENABLED";

export function sandboxConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): SandboxConfiguration {
  const raw = environment[SANDBOX_ENABLED_ENVIRONMENT];
  const platform = process.platform;

  if (raw === undefined || raw === "" || raw === "false") {
    return {
      enabled: false,
      initialStatus: {
        enabled: false,
        mode: "non-isolated",
        platform,
        level: null,
        reason: "Sandbox 已关闭；命令按现有 V1 宿主权限执行。",
      },
    };
  }

  if (raw === "true") {
    return {
      enabled: true,
      initialStatus: {
        enabled: true,
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
