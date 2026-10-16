/**
 * 显式离线设置迁移服务，供手动 CLI 和临时目录测试使用，不参与正常启动。
 * 1. inspectLegacyEnvironment 只解析指定 dotenv 数据，报告未知产品字段和环境冲突（仅名称）。
 * 2. createSettingsCandidate 按旧优先级读取选定目录，生成独立私有候选，不修改原设置。
 * 3. activateSettingsCandidate 校验私有候选，备份并切换旧设置；要求调用方确认已停止服务。
 * 不扫描工作区、不执行 dotenv、不删除原件、不迁移历史库；错误不携带凭据或原始异常。
 */
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Config } from "./config.js";
import { legacyDocument } from "./legacy-settings.js";
import { SettingsStore, parseDocument } from "./settings-store.js";
import {
  readSettingsText,
  verifyPrivateSettings,
  writePrivateSettings,
} from "./private-settings-file.js";

const supported = new Set(
  [
    "API_PROTOCOL",
    "BASE_URL",
    "MODEL",
    "API_KEY",
    "REASONING_EFFORT",
    "AUXILIARY_API_PROTOCOL",
    "AUXILIARY_BASE_URL",
    "AUXILIARY_MODEL",
    "AUXILIARY_API_KEY",
    "AUXILIARY_REASONING_EFFORT",
    "DATA_DIR",
    "LOG_LEVEL",
    "PORT",
    "LISTEN_ADDRESS",
    "WEB_PASSWORD_ENABLED",
    "WEB_PASSWORD",
    "SANDBOX_ENABLED",
    "SANDBOX_READ_ROOTS",
    "SANDBOX_WRITE_ROOTS",
    "SANDBOX_NATIVE_ROOT",
    "SANDBOX_STATE_PATH",
    "TRACE_MAX_RECORDS",
    "TRACE_MAX_BYTES",
    "TRACE_CHECKPOINT_MS",
    "TRACE_RETENTION_DAYS",
    "MCP_CONFIG",
  ].map((name) => `CODEATELIER_${name}`),
);

export function inspectLegacyEnvironment(
  text: string,
  environment: NodeJS.ProcessEnv,
) {
  const parsed = parseEnv(text);
  const unknown = Object.keys(parsed).filter(
    (name) => name.startsWith("CODEATELIER_") && !supported.has(name),
  );
  const conflicts = Object.keys(parsed).filter(
    (name) =>
      supported.has(name) &&
      environment[name] !== undefined &&
      environment[name] !== parsed[name],
  );
  const names = Object.keys(parsed).filter((name) => supported.has(name));

  return { parsed, names, unknown, conflicts };
}

export async function createSettingsCandidate(
  directory: string,
  envFile: string,
  write = false,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const text = readSettingsText(envFile);
  if (text === null) {
    throw new Error("指定的旧 dotenv 文件不存在。");
  }

  const inspection = inspectLegacyEnvironment(text, environment);
  if (inspection.unknown.length || inspection.conflicts.length) {
    throw new Error(
      `迁移预检失败；未知字段：${inspection.unknown.join(", ") || "无"}；环境冲突：${inspection.conflicts.join(", ") || "无"}。`,
    );
  }

  const targetText = readSettingsText(path.join(directory, "settings.json"));
  if (targetText?.includes('"schemaVersion"')) {
    throw new Error("目标已包含版本信息，不重复迁移或覆盖。");
  }

  // 兼容 Config 的旧解析器在构造时读取进程环境；只在这段同步构造期间替换已知产品字段。
  const previous = { ...process.env };
  let config: Config;
  try {
    for (const name of supported) {
      const value = inspection.parsed[name] ?? environment[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    config = new Config(directory, { legacy: true });
  } catch {
    throw new Error(
      "旧配置预检失败；检查主模型连接、偏好、门禁与 MCP 文件，未修改原件。",
    );
  } finally {
    for (const name of supported) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }

  const env = config.startupEnvironment;
  const candidate = await legacyDocument(
    config.settings,
    config.apiKey,
    env.CODEATELIER_AUXILIARY_API_KEY,
    config.mcpServers,
    env,
  );
  const file = path.join(directory, `settings.candidate-${randomUUID()}.json`);
  if (write) {
    writePrivateSettings(file, JSON.stringify(candidate, null, 2) + "\n");
  }

  return {
    valid: true,
    sources: inspection.names,
    candidatePath: write ? file : undefined,
    containsCredentials: true,
    mode: write ? "candidate-written" : "preflight-only",
  };
}

export async function activateSettingsCandidate(
  directory: string,
  candidateFile: string,
  confirmStopped: boolean,
) {
  if (!confirmStopped) {
    throw new Error("先停止服务，再使用 --confirm-stopped 显式确认切换。");
  }

  verifyPrivateSettings(candidateFile);
  const text = readSettingsText(candidateFile);
  if (!text) {
    throw new Error("候选文件不存在。");
  }

  const document = parseDocument(text);
  const target = readSettingsText(path.join(directory, "settings.json"));
  if (target?.includes('"schemaVersion"')) {
    throw new Error("目标已为版本化配置，拒绝重复迁移。");
  }

  const store = new SettingsStore(directory, document);
  await store.update({
    expectedRevision: store.view().revision,
    confirmMigration: true,
  });

  return { activated: true, file: store.file };
}
