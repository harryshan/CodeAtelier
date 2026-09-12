/**
 * 文件作用：管理后端配置加载、更新和面向浏览器的安全视图。
 * 代码结构：Config 从默认值、环境和保存文件初始化，随后提供规范化、持久化更新及隐藏密钥的公开值。
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

    this.settings = settingsSchema.parse({
      ...{
        baseUrl:
          process.env.CODEATELIER_BASE_URL || "http://jp.harryshan.com:4141/v1",
        model: process.env.CODEATELIER_MODEL || "codex/gpt-5.6-luna",
        reasoningEffort: process.env.CODEATELIER_REASONING_EFFORT || "high",
        maxSteps: 30,
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
    if (this.settings.model === "5.6-luna") {
      this.settings.model = "codex/gpt-5.6-luna";
    }
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
    if (parsed.settings.model === "5.6-luna") {
      parsed.settings.model = "codex/gpt-5.6-luna";
    }

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
