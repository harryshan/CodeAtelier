/**
 * 检查 Config 将连接配置与可持久化偏好分离后的来源、保存和密钥处理。
 * 用临时目录和模拟环境变量测试，直接读取 settings.json 核对实际保存内容。
 *
 * 1. 验证 API 地址、主/辅助模型始终来自环境，保存偏好不会覆盖它们。
 * 2. 验证 UI 更新拒绝连接字段改动，只原子保存思考等级和执行限制。
 * 3. 区分不传密钥与清空密钥，检查损坏文件、旧 settings.json 迁移和缺失环境配置。
 *
 * 用例结束后恢复环境变量，避免影响其他测试；密钥和部署连接信息不能出现在 settings.json 中。
 */

import { it, expect, vi, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { dataDirectory } from "../src/config/data-directory.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => vi.unstubAllEnvs());

it("uses the explicit data directory and keeps the environment model authoritative", async () => {
  const root = await temp();

  vi.stubEnv("CODEATELIER_DATA_DIR", root);
  vi.stubEnv("CODEATELIER_MODEL", "env-model");

  expect(dataDirectory()).toBe(root);
  const initial = new Config();

  expect(initial.settings.model).toBe("env-model");
  expect(initial.settings.maxSteps).toBe(100);
  expect(initial.settings.maxConcurrentTasks).toBe(2);
  initial.update({
    settings: { ...initial.settings, reasoningEffort: "low" },
  });
  vi.stubEnv("CODEATELIER_MODEL", "next-environment-model");

  const reopened = new Config(root);
  expect(reopened.settings.model).toBe("next-environment-model");
  expect(reopened.settings.reasoningEffort).toBe("low");
});

it("normalizes environment connections and persists only preferences and memory keys", async () => {
  vi.stubEnv("CODEATELIER_BASE_URL", "http://localhost:8888/v1/responses/");
  vi.stubEnv("CODEATELIER_MODEL", "custom/model-id");
  vi.stubEnv("CODEATELIER_AUXILIARY_MODEL", "small-model");
  const root = await temp();
  const config = new Config(root);

  config.update({
    settings: { ...config.settings, reasoningEffort: "medium" },
    apiKey: "test-memory-secret",
  });

  expect(config.settings.baseUrl).toBe("http://localhost:8888/v1");
  expect(config.settings.model).toBe("custom/model-id");
  expect(JSON.stringify(config.publicValue())).not.toContain(
    "test-memory-secret",
  );
  expect(new Config(root).settings).toEqual(config.settings);

  const saved = await readFile(path.join(root, "settings.json"), "utf8");
  expect(saved).not.toContain("test-memory-secret");
  expect(saved).not.toContain("localhost:8888");
  expect(saved).not.toContain("custom/model-id");
  expect(saved).not.toContain("small-model");
});

it("rejects connection changes instead of silently selecting a competing source", async () => {
  const root = await temp();
  const config = new Config(root);

  expect(() =>
    config.update({
      settings: { ...config.settings, model: "different-model" },
    }),
  ).toThrow("由 .env 或进程环境配置");
  expect(() =>
    config.update({
      settings: { ...config.settings, baseUrl: "https://api.example.test/v1" },
    }),
  ).toThrow("由 .env 或进程环境配置");
  expect(() =>
    config.update({
      settings: { ...config.settings, auxiliaryModel: "different-small" },
    }),
  ).toThrow("由 .env 或进程环境配置");
  expect(() =>
    config.update({
      settings: { ...config.settings, baseUrl: "file:///tmp/a" },
    }),
  ).toThrow();
  expect(config.settings.model).not.toBe("different-model");
});

it.each([
  { maxSteps: 0 },
  { maxConcurrentTasks: 5 },
  { idleTimeoutMs: 300001 },
  { requestTimeoutMs: 0 },
  { contextChars: 9999 },
  { logLevel: "invalid" },
  { reasoningEffort: "invalid" },
])("rejects invalid preferences atomically: %j", async (invalid) => {
  const root = await temp();
  const config = new Config(root);

  config.update({ settings: config.settings, apiKey: "old-key" });
  const before = await readFile(path.join(root, "settings.json"), "utf8");
  const settings = { ...config.settings };

  expect(() =>
    config.update({ settings: { ...settings, ...invalid }, apiKey: "new-key" }),
  ).toThrow();
  expect(config.settings).toEqual(settings);
  expect(config.apiKey).toBe("old-key");
  expect(await readFile(path.join(root, "settings.json"), "utf8")).toBe(before);
});

it("preserves omitted keys and allows explicit clearing", async () => {
  const config = new Config(await temp());

  config.apiKey = "old";
  config.update({ settings: config.settings });

  expect(config.apiKey).toBe("old");
  config.update({ settings: config.settings, apiKey: "" });

  expect(config.publicValue().hasApiKey).toBe(false);
});

it("reports malformed saved settings without silently overwriting them", async () => {
  const root = await temp();

  await writeFile(path.join(root, "settings.json"), "broken-json");

  expect(() => new Config(root)).toThrow();
  expect(await readFile(path.join(root, "settings.json"), "utf8")).toBe(
    "broken-json",
  );
});

it("migrates legacy connection fields out of settings.json and persists effort", async () => {
  vi.stubEnv("CODEATELIER_REASONING_EFFORT", "");
  const root = await temp();
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ model: "legacy", baseUrl: "https://legacy.example/v1" }),
  );
  const config = new Config(root);

  expect(config.settings.reasoningEffort).toBe("high");
  expect(config.settings.model).not.toBe("legacy");
  vi.stubEnv("CODEATELIER_REASONING_EFFORT", "low");
  expect(new Config(root).settings.reasoningEffort).toBe("low");

  for (const reasoningEffort of ["low", "medium", "high"] as const) {
    config.update({ settings: { ...config.settings, reasoningEffort } });
    expect(new Config(root).settings.reasoningEffort).toBe(reasoningEffort);
  }

  expect(
    await readFile(path.join(root, "settings.json"), "utf8"),
  ).not.toContain("legacy");
});

it("uses the configured endpoint and model verbatim except endpoint suffix", async () => {
  vi.stubEnv("CODEATELIER_BASE_URL", "https://api.example.com/v1/responses/");
  vi.stubEnv("CODEATELIER_MODEL", "custom/model-id");
  const config = new Config(await temp());

  expect(config.settings.baseUrl).toBe("https://api.example.com/v1");
  expect(config.settings.model).toBe("custom/model-id");
});

it.each(["CODEATELIER_BASE_URL", "CODEATELIER_MODEL"])(
  "requires %s even when a legacy settings.json has connection values",
  async (name) => {
    vi.stubEnv(name, "");
    const root = await temp();
    await writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ baseUrl: "https://legacy.example/v1", model: "legacy" }),
    );

    expect(() => new Config(root)).toThrow(name);
  },
);
