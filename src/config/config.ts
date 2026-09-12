/**
 * 文件作用：管理后端配置加载、更新和面向浏览器的安全视图。
 *
 * 模块协作与输入输出：
 * 由服务及开发入口创建，向 Engine 提供设置和内存密钥，并向 API 提供不含密钥正文的配置视图。
 *
 * 代码结构与执行顺序：
 * 1. 构造器创建数据目录，将保存的 settings.json 覆盖环境默认值，再通过 settingsSchema 校验。
 * 2. normalize 去除端点的 responses 后缀和尾斜杠，并把已知模型简写转为完整标识。
 * 3. update 校验新设置，先写临时文件并重命名，成功后才替换内存设置及可选密钥。
 * 4. publicValue 返回 settings 与 hasApiKey，供浏览器显示配置状态。
 *
 * 关键约束：
 * 密钥不写入 settings.json；未传密钥表示保留，显式空字符串表示清除；损坏配置不能静默覆盖。
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
