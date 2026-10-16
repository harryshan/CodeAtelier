/**
 * 加载和保存后端配置，并向浏览器提供不含密钥的配置视图。
 * 服务入口创建 Config，Engine 从中读取设置和内存中的密钥，API 使用 publicValue。
 *
 * 1. 构造器准备数据目录，只从环境读取连接配置，再读取 settings.json 中的可持久化偏好。
 *    同时读取仅后端持有的 mcp.json；MCP 配置不进入 publicValue 或 Runtime 设置。
 * 2. normalizeBaseUrl 去掉端点末尾的 responses、chat/completions、messages 和斜杠；模型 ID 保持环境变量的原样。
 * 3. update 拒绝修改连接字段，只原子保存偏好；浏览器输入的密钥仅覆盖本次进程。
 * 4. modelKey 按用途选择密钥，跨端点/协议不继承；errorSecrets 提供全体模型密钥用于脱敏。
 * 5. publicValue 返回运行时设置、密钥状态和启动期 sandbox 模式，浏览器据此显示实际命令边界。
 *
 * API 地址、主/辅助模型、环境密钥和 sandbox 开关的基线只来自 .env 或进程环境，避免与 settings.json 竞争。
 * 密钥不写进 settings.json。已保存的配置损坏时应报错，不能悄悄用默认值覆盖。
 * tracing 环境配置在启动时校验容量、检查点和可选保留期；不向浏览器暴露或持久化为偏好。
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  connectionSettingsSchema,
  persistedSettingsSchema,
  settingsSchema,
} from "./settings.js";
import { loadMcpServers, type McpServers } from "../mcp/config.js";
import { dataDirectory } from "./data-directory.js";
import { sandboxConfiguration } from "../sandbox/config.js";
import type { SandboxConfiguration } from "../sandbox/types.js";
import { traceConfiguration } from "../tracing/config.js";

type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;
type PersistedSettings = z.infer<typeof persistedSettingsSchema>;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl
    .replace(/\/(responses|chat\/completions|messages)\/?$/, "")
    .replace(/\/$/, "");
}

export class Config {
  settings: z.infer<typeof settingsSchema>;
  private connection: ConnectionSettings;
  apiKey = process.env.CODEATELIER_API_KEY || "";
  private auxiliaryApiKey = process.env.CODEATELIER_AUXILIARY_API_KEY;
  readonly sandbox: SandboxConfiguration;
  readonly mcpServers: McpServers;
  readonly tracing = traceConfiguration();

  constructor(public directory = dataDirectory()) {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "settings.json");
    const saved = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : {};

    this.connection = this.readEnvironmentConnection();
    this.sandbox = sandboxConfiguration();
    this.mcpServers = loadMcpServers(directory);
    this.settings = this.runtimeSettings(this.savedPreferences(saved));
  }

  private readEnvironmentConnection(): ConnectionSettings {
    for (const variable of [
      "CODEATELIER_BASE_URL",
      "CODEATELIER_MODEL",
    ] as const) {
      if (!process.env[variable]) {
        throw new Error(
          `Set ${variable} in .env or the environment before startup.`,
        );
      }
    }

    const connection = connectionSettingsSchema.parse({
      protocol: process.env.CODEATELIER_API_PROTOCOL || "responses",
      auxiliaryProtocol:
        process.env.CODEATELIER_AUXILIARY_API_PROTOCOL || undefined,
      auxiliaryBaseUrl: process.env.CODEATELIER_AUXILIARY_BASE_URL || undefined,
      baseUrl: process.env.CODEATELIER_BASE_URL,
      model: process.env.CODEATELIER_MODEL,
      auxiliaryModel: process.env.CODEATELIER_AUXILIARY_MODEL || "",
    });

    return {
      ...connection,
      baseUrl: normalizeBaseUrl(connection.baseUrl),
      auxiliaryBaseUrl: connection.auxiliaryBaseUrl
        ? normalizeBaseUrl(connection.auxiliaryBaseUrl)
        : undefined,
    };
  }

  private savedPreferences(saved: unknown): PersistedSettings {
    return persistedSettingsSchema.parse({
      reasoningEffort: process.env.CODEATELIER_REASONING_EFFORT || "high",
      auxiliaryReasoningEffort:
        process.env.CODEATELIER_AUXILIARY_REASONING_EFFORT || "low",
      maxSteps: 100,
      maxConcurrentTasks: 2,
      commandTimeoutMs: 0,
      requestTimeoutMs: 300000,
      idleTimeoutMs: 60000,
      maxContextTokens: 300000,
      contextChars: 1_000_000,
      outputChars: 32000,
      logLevel: process.env.CODEATELIER_LOG_LEVEL || "info",
      ...((saved as object) || {}),
    });
  }

  private runtimeSettings(preferences: PersistedSettings) {
    return settingsSchema.parse({ ...this.connection, ...preferences });
  }

  private assertConnectionUnchanged(settings: z.infer<typeof settingsSchema>) {
    const requested = {
      protocol: settings.protocol,
      auxiliaryProtocol: settings.auxiliaryProtocol,
      auxiliaryBaseUrl: settings.auxiliaryBaseUrl
        ? normalizeBaseUrl(settings.auxiliaryBaseUrl)
        : undefined,
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      model: settings.model,
      auxiliaryModel: settings.auxiliaryModel,
    };

    if (
      requested.protocol !== this.connection.protocol ||
      requested.auxiliaryProtocol !== this.connection.auxiliaryProtocol ||
      requested.auxiliaryBaseUrl !== this.connection.auxiliaryBaseUrl ||
      requested.baseUrl !== this.connection.baseUrl ||
      requested.model !== this.connection.model ||
      requested.auxiliaryModel !== this.connection.auxiliaryModel
    ) {
      throw new Error(
        "API 地址和模型由 .env 或进程环境配置；修改后请重启或重载服务。",
      );
    }
  }

  update(value: unknown) {
    const parsed = z
      .object({
        settings: settingsSchema,
        apiKey: z.string().max(4096).optional(),
      })
      .parse(value);

    this.assertConnectionUnchanged(parsed.settings);
    const preferences = persistedSettingsSchema.parse(parsed.settings);
    const nextSettings = this.runtimeSettings(preferences);
    const file = path.join(this.directory, "settings.json");

    // 校验和磁盘写入都成功后才切换内存设置，失败时保留当前配置。
    writeFileSync(file + ".tmp", JSON.stringify(preferences, null, 2), {
      mode: 0o600,
    });
    renameSync(file + ".tmp", file);
    this.settings = nextSettings;
    if (parsed.apiKey !== undefined) {
      this.apiKey = parsed.apiKey;
    }
  }

  /** 不把主密钥隐式发送给不同的辅助端点或协议；缺少专用密钥时由 Provider 明确拒绝。 */
  modelKey(auxiliary = false): string {
    if (!auxiliary || !this.settings.auxiliaryModel) {
      return this.apiKey;
    }

    if (this.auxiliaryApiKey !== undefined) {
      return this.auxiliaryApiKey;
    }

    const sameEndpoint =
      !this.settings.auxiliaryBaseUrl ||
      this.settings.auxiliaryBaseUrl === this.settings.baseUrl;
    const sameProtocol =
      !this.settings.auxiliaryProtocol ||
      this.settings.auxiliaryProtocol === this.settings.protocol;

    return sameEndpoint && sameProtocol ? this.apiKey : "";
  }

  errorSecrets(): string[] {
    return [this.apiKey, this.auxiliaryApiKey ?? ""];
  }

  publicValue() {
    return {
      sandbox: this.sandbox.initialStatus,
      settings: this.settings,
      hasApiKey: !!this.apiKey,
    };
  }
}
