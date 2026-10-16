/**
 * 显式迁移旧配置为 v1 候选，Config 的兼容路径与离线迁移入口共用。
 * 1. 从已经按旧优先级解析的 Settings/MCP 和构造时环境快照获取配置，不复活旧连接字段。
 * 2. 将密码派生为验证材料；辅助密钥继承明确建模，端点/协议仍沿用旧有效值。
 * 3. 返回严格校验后的私有候选；不写盘、不删 env、不重启、不输出任何凭据。
 */
import { documentSchema, defaultDocument } from "./settings-document.js";
import { hashPassword } from "./password.js";
import type { Settings } from "../shared/types.js";
import type { McpServers } from "../mcp/config.js";
import { traceConfiguration } from "../tracing/config.js";
import { listeningAddress } from "../server/listen-address.js";

export async function legacyDocument(
  settings: Settings,
  apiKey: string,
  auxiliaryKey: string | undefined,
  mcp: McpServers,
  env: NodeJS.ProcessEnv,
) {
  const result = defaultDocument();
  result.models.main = {
    protocol: settings.protocol ?? "responses",
    baseUrl: settings.baseUrl,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort ?? "high",
    apiKey,
  };
  result.models.auxiliary = {
    enabled: !!settings.auxiliaryModel,
    model: settings.auxiliaryModel ?? "",
    protocol: settings.auxiliaryProtocol ?? settings.protocol ?? "responses",
    baseUrl: settings.auxiliaryBaseUrl ?? settings.baseUrl,
    reasoningEffort: settings.auxiliaryReasoningEffort ?? "low",
    apiKey: auxiliaryKey ?? "",
    inheritConnection:
      !settings.auxiliaryBaseUrl && !settings.auxiliaryProtocol,
    inheritKey:
      auxiliaryKey === undefined &&
      (!settings.auxiliaryBaseUrl ||
        settings.auxiliaryBaseUrl === settings.baseUrl) &&
      (!settings.auxiliaryProtocol ||
        settings.auxiliaryProtocol === settings.protocol),
  };
  for (const key of Object.keys(
    result.execution,
  ) as (keyof typeof result.execution)[]) {
    result.execution[key] = settings[key];
  }

  result.context = {
    maxOutputTokens: settings.maxOutputTokens ?? 16384,
    maxContextTokens: settings.maxContextTokens,
    contextChars: settings.contextChars,
  };
  result.logging.level = settings.logLevel as typeof result.logging.level;
  result.tracing = traceConfiguration(env);
  result.mcp.servers = structuredClone(mcp);
  const roots = (name: string) => {
    try {
      return JSON.parse(env[name] || "[]") as string[];
    } catch {
      throw new Error("旧 Sandbox 授权根必须为 JSON 数组。");
    }
  };

  result.sandbox = {
    enabled: env.CODEATELIER_SANDBOX_ENABLED === "true",
    readRoots: roots("CODEATELIER_SANDBOX_READ_ROOTS"),
    writeRoots: roots("CODEATELIER_SANDBOX_WRITE_ROOTS"),
    nativeRoot: env.CODEATELIER_SANDBOX_NATIVE_ROOT || "",
    statePath: env.CODEATELIER_SANDBOX_STATE_PATH || "",
  };
  result.server = {
    listenAddress: listeningAddress(env) as typeof result.server.listenAddress,
    port: Number(env.CODEATELIER_PORT || 4142),
    passwordEnabled: env.CODEATELIER_WEB_PASSWORD_ENABLED === "true",
    passwordHash: env.CODEATELIER_WEB_PASSWORD
      ? await hashPassword(env.CODEATELIER_WEB_PASSWORD)
      : "",
  };
  try {
    return documentSchema.parse(result);
  } catch {
    throw new Error(
      "旧配置无法完整迁移，请检查连接、门禁及 Sandbox 配置；未写入文件。",
    );
  }
}
