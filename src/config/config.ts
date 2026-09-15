/**
 * 加载和保存后端配置，并向浏览器提供不含密钥的配置视图。
 * 服务入口创建 Config，Engine 从中读取设置和内存中的密钥，API 使用 publicValue。
 *
 * 1. 构造器准备数据目录，以环境变量作为默认值，再用 settings.json 中的设置覆盖并校验。
 * 2. normalize 去掉端点末尾的 responses 和斜杠；模型 ID 保持用户填写的原样。
 * 3. update 校验新配置，先写临时文件并重命名，成功后再更新内存中的设置和密钥。
 * 4. publicValue 返回设置及 hasApiKey，浏览器据此显示是否已经配置密钥。
 *
 * 密钥只留在内存，不写进 settings.json。更新时不传密钥表示保留，传空字符串表示清除。
 * 已保存的配置损坏时应报错，不能悄悄用默认值覆盖。
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
import { settingsSchema } from "./settings.js";
import { dataDirectory } from "./data-directory.js";

export class Config {
  settings: z.infer<typeof settingsSchema>;
  apiKey = process.env.CODEATELIER_API_KEY || "";
  constructor(public directory = dataDirectory()) {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "settings.json");
    const saved = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : {};

    for (const [field, variable] of [
      ["baseUrl", "CODEATELIER_BASE_URL"],
      ["model", "CODEATELIER_MODEL"],
    ] as const) {
      if (!(saved[field] ?? process.env[variable])) {
        throw new Error(
          `Set ${variable} in .env or the environment before startup.`,
        );
      }
    }

    this.settings = settingsSchema.parse({
      ...{
        baseUrl: process.env.CODEATELIER_BASE_URL,
        model: process.env.CODEATELIER_MODEL,
        reasoningEffort: process.env.CODEATELIER_REASONING_EFFORT || "high",
        auxiliaryModel: process.env.CODEATELIER_AUXILIARY_MODEL || "",
        auxiliaryReasoningEffort:
          process.env.CODEATELIER_AUXILIARY_REASONING_EFFORT || "low",
        maxSteps: 100,
        commandTimeoutMs: 120000,
        requestTimeoutMs: 300000,
        idleTimeoutMs: 60000,
        contextChars: 180000,
        outputChars: 32000,
        logLevel: process.env.CODEATELIER_LOG_LEVEL || "info",
      },
      ...saved,
    });
    this.normalize();
  }

  normalize() {
    this.settings.baseUrl = this.settings.baseUrl
      .replace(/\/responses\/?$/, "")
      .replace(/\/$/, "");
  }

  update(value: unknown) {
    const parsed = z
      .object({
        settings: settingsSchema,
        apiKey: z.string().max(4096).optional(),
      })
      .parse(value);

    parsed.settings.baseUrl = parsed.settings.baseUrl
      .replace(/\/responses\/?$/, "")
      .replace(/\/$/, "");

    const file = path.join(this.directory, "settings.json");

    // 校验和磁盘写入都成功后才切换内存设置，失败时保留当前配置。
    writeFileSync(file + ".tmp", JSON.stringify(parsed.settings, null, 2), {
      mode: 0o600,
    });
    renameSync(file + ".tmp", file);
    this.settings = parsed.settings;
    if (parsed.apiKey !== undefined) {
      this.apiKey = parsed.apiKey;
    }
  }

  publicValue() {
    return { settings: this.settings, hasApiKey: !!this.apiKey };
  }
}
