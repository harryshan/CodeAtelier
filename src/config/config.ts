/**
 * 加载和保存后端配置，并向浏览器提供不含密钥的配置视图。
 * 服务入口创建 Config，Engine 从中读取设置和内存中的密钥，API 使用 publicValue。
 *
 * 1. 构造器优先读取 v1 私有 settings.json；空安装可进入引导。legacy 兼容路径仅供显式迁移和旧调用方。
 *    MCP 和密钥留在宿主，不能作为普通 Settings 投影给 Runtime。
 * 2. normalizeBaseUrl 去掉端点末尾的 responses、chat/completions、messages 和斜杠；模型 ID 保持用户输入原样。
 * 3. editor/updateDocument/reloadDocument 经 SettingsStore 保存版本化局部更新；旧 update 仅维护迁移前兼容契约。
 * 4. modelKey 按用途选择密钥，跨端点/协议不继承；errorSecrets 提供全体模型密钥用于脱敏。
 * 5. publicValue 返回运行时设置、密钥状态和启动期 sandbox 模式，浏览器据此显示实际命令边界。
 *
 * 6. taskSnapshot 固定每个任务的设置、主/辅助密钥与 MCP；旧密钥保留在进程脱敏集合直到退出。
 * v1 文件是唯一产品配置来源，损坏时不覆盖、不回退环境。Sandbox/server 的有效值固定于启动。
 * 私有 JSON 不是加密存储；公开 editor 视图由独立投影产生。
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
import type { Settings } from "../shared/types.js";
import { SettingsStore } from "./settings-store.js";
import { runtimeSettings, type SettingsDocument } from "./settings-document.js";
import { legacyDocument } from "./legacy-settings.js";
import { mcpSecrets } from "../mcp/config.js";

type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;
type PersistedSettings = z.infer<typeof persistedSettingsSchema>;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl
    .replace(/\/(responses|chat\/completions|messages)\/?$/, "")
    .replace(/\/$/, "");
}

export class Config {
  settings: Settings;
  private connection?: ConnectionSettings;
  apiKey = "";
  private auxiliaryApiKey?: string;
  readonly sandbox: SandboxConfiguration;
  mcpServers: McpServers;
  tracing: ReturnType<typeof traceConfiguration>;
  readonly server?: SettingsDocument["server"];
  readonly startupEnvironment: NodeJS.ProcessEnv;
  private settingsStore?: SettingsStore;
  private editorPromise?: Promise<SettingsStore>;
  private readonly retiredSecrets = new Set<string>();

  constructor(
    public directory = dataDirectory(),
    options: { legacy?: boolean } = {},
  ) {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "settings.json");
    let saved: unknown = {};
    try {
      saved = existsSync(file)
        ? JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
        : {};
    } catch {
      throw new Error("设置文件无法解析；请本地修复，原文件不会被覆盖。");
    }

    if (
      (saved as { schemaVersion?: unknown })?.schemaVersion !== undefined ||
      (!existsSync(file) &&
        (options.legacy === false || !process.env.CODEATELIER_BASE_URL))
    ) {
      this.settingsStore = new SettingsStore(directory);
      const document = this.settingsStore.document;
      this.settings = runtimeSettings(document);
      this.apiKey = document.models.main.apiKey;
      this.auxiliaryApiKey = this.documentAuxiliaryKey(document);
      this.mcpServers = document.mcp.servers;
      this.tracing = document.tracing;
      this.server = document.server;
      this.startupEnvironment = {
        ...process.env,
        CODEATELIER_SANDBOX_NATIVE_ROOT: document.sandbox.nativeRoot,
        CODEATELIER_SANDBOX_STATE_PATH: document.sandbox.statePath,
        CODEATELIER_SANDBOX_READ_ROOTS: JSON.stringify(
          document.sandbox.readRoots,
        ),
        CODEATELIER_SANDBOX_WRITE_ROOTS: JSON.stringify(
          document.sandbox.writeRoots,
        ),
      };
      this.sandbox = sandboxConfiguration({
        CODEATELIER_SANDBOX_ENABLED: String(document.sandbox.enabled),
      });

      return;
    }

    if (options.legacy === false) {
      throw new Error(
        "检测到旧 settings.json；请停止服务后使用 settings:migrate 显式迁移，原文件未修改。",
      );
    }

    this.startupEnvironment = { ...process.env };
    this.apiKey = process.env.CODEATELIER_API_KEY || "";
    this.auxiliaryApiKey = process.env.CODEATELIER_AUXILIARY_API_KEY;
    this.tracing = traceConfiguration();
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

    if (!this.connection) {
      throw new Error(
        "旧 PUT 设置接口已退役，请使用有 revision 的 PATCH 接口。",
      );
    }

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
    if (this.settingsStore && !this.settingsStore.legacy) {
      throw new Error(
        "旧 PUT 设置接口已退役，请使用有 revision 的 PATCH 接口。",
      );
    }

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
    this.rememberSecrets();
    this.settings = nextSettings;
    this.editorPromise = undefined;
    this.settingsStore = undefined;
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
    return [
      ...this.retiredSecrets,
      this.apiKey,
      this.auxiliaryApiKey ?? "",
      ...mcpSecrets(this.mcpServers),
    ];
  }

  private rememberSecrets() {
    for (const secret of this.errorSecrets()) {
      if (secret) {
        this.retiredSecrets.add(secret);
      }
    }
  }

  private documentAuxiliaryKey(document: SettingsDocument) {
    return document.models.auxiliary.inheritKey
      ? document.models.main.apiKey
      : document.models.auxiliary.apiKey;
  }

  private editorStore(): Promise<SettingsStore> {
    if (this.settingsStore) {
      return Promise.resolve(this.settingsStore);
    }

    this.editorPromise ??= legacyDocument(
      this.settings,
      this.apiKey,
      this.auxiliaryApiKey,
      this.mcpServers,
      this.startupEnvironment,
    ).then((candidate) => {
      this.settingsStore = new SettingsStore(this.directory, candidate);

      return this.settingsStore;
    });

    return this.editorPromise;
  }

  async editorValue() {
    return (await this.editorStore()).view();
  }

  async validateDocument(value: unknown) {
    return (await this.editorStore()).validate(value);
  }

  private publishDocument(store: SettingsStore) {
    this.rememberSecrets();
    const document = store.document;
    this.settings = runtimeSettings(document);
    this.apiKey = document.models.main.apiKey;
    this.auxiliaryApiKey = this.documentAuxiliaryKey(document);
    this.mcpServers = document.mcp.servers;
    this.tracing = {
      ...this.tracing,
      maxRecords: document.tracing.maxRecords,
      maxBytes: document.tracing.maxBytes,
    };
  }

  async updateDocument(value: unknown) {
    const store = await this.editorStore();
    const result = await store.update(value);
    this.publishDocument(store);

    return result;
  }

  async reloadDocument(revision: string) {
    const store = await this.editorStore();
    const result = await store.reload(revision);
    this.publishDocument(store);

    return result;
  }

  taskSnapshot() {
    const settings = Object.freeze({ ...this.settings });
    const mainKey = this.modelKey();
    const auxiliaryKey = this.modelKey(true);
    const servers = structuredClone(this.mcpServers);
    for (const server of Object.values(servers)) {
      if (server.transport === "stdio") {
        Object.freeze(server.args);
        Object.freeze(server.env);
      } else {
        Object.freeze(server.headers);
      }

      Object.freeze(server);
    }

    Object.freeze(servers);

    return Object.freeze({
      settings,
      mcpServers: servers,
      revision: this.settingsStore?.view().revision ?? "legacy",
      tracing: Object.freeze({ ...this.tracing }),
      modelKey: (auxiliary = false) => (auxiliary ? auxiliaryKey : mainKey),
    });
  }

  publicValue() {
    return {
      sandbox: this.sandbox.initialStatus,
      settings: this.settings,
      hasApiKey: !!this.apiKey,
    };
  }
}
