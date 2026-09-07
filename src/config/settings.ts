import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
export const settingsSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
  model: z.string().min(1).max(200),
  maxSteps: z.number().int().min(1).max(100),
  commandTimeoutMs: z.number().int().min(1000).max(600000),
  requestTimeoutMs: z.number().int().min(1000).max(600000),
  idleTimeoutMs: z.number().int().min(1000).max(300000),
  contextChars: z.number().int().min(10000).max(2000000),
  outputChars: z.number().int().min(1000).max(100000),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
});
export function dataDirectory() {
  if (process.env.CODEATELIER_DATA_DIR)
    return path.resolve(process.env.CODEATELIER_DATA_DIR);
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support")
        : process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(base, "CodeAtelier");
}
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
  }
  normalize() {
    this.settings.baseUrl = this.settings.baseUrl
      .replace(/\/responses\/?$/, "")
      .replace(/\/$/, "");
    if (this.settings.model === "5.6-luna")
      this.settings.model = "codex/gpt-5.6-luna";
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
    if (parsed.settings.model === "5.6-luna")
      parsed.settings.model = "codex/gpt-5.6-luna";
    const file = path.join(this.directory, "settings.json");
    writeFileSync(file + ".tmp", JSON.stringify(parsed.settings, null, 2), {
      mode: 0o600,
    });
    renameSync(file + ".tmp", file);
    this.settings = parsed.settings;
    if (parsed.apiKey !== undefined) this.apiKey = parsed.apiKey;
  }
  publicValue() {
    return { settings: this.settings, hasApiKey: !!this.apiKey };
  }
}
