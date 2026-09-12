/**
 * 文件作用：验证配置优先级、规范化、持久化及密钥处理。
 *
 * 使用场景与输入输出：
 * 使用临时数据目录与环境替身实例化 Config，通过重建实例和读取 settings.json 验证持久化结果。
 *
 * 代码结构与阅读顺序：
 * 1. 先验证显式数据目录、环境默认值和保存设置的优先级。
 * 2. 更新场景核对端点规范化、模型简写、磁盘内容以及内存密钥。
 * 3. 分别测试省略密钥、显式清空、损坏保存文件和思考等级的兼容默认值。
 *
 * 维护注意事项：
 * 断言涵盖实际保存内容与重启读取，不能仅检查内存值；测试后恢复环境避免影响其他用例。
 */

import { it, expect, vi, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Config } from "../src/config/config.js";
import { dataDirectory } from "../src/config/data-directory.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => vi.unstubAllEnvs());

it("uses explicit data directory and saved settings take precedence over environment", async () => {
  const root = await temp();

  vi.stubEnv("CODEATELIER_DATA_DIR", root);
  vi.stubEnv("CODEATELIER_MODEL", "env-model");

  expect(dataDirectory()).toBe(root);
  const initial = new Config();

  expect(initial.settings.model).toBe("env-model");
  initial.update({ settings: { ...initial.settings, model: "saved-model" } });

  expect(new Config(root).settings.model).toBe("saved-model");
});

it("normalizes updated settings, persists across restart and keeps key in memory", async () => {
  const root = await temp();
  const config = new Config(root);

  config.update({
    settings: {
      ...config.settings,
      baseUrl: "http://localhost:8888/v1/responses/",
      model: "5.6-luna",
    },
    apiKey: "test-memory-secret",
  });

  expect(config.settings.baseUrl).toBe("http://localhost:8888/v1");
  expect(config.settings.model).toBe("codex/gpt-5.6-luna");
  expect(JSON.stringify(config.publicValue())).not.toContain(
    "test-memory-secret",
  );
  expect(new Config(root).settings).toEqual(config.settings);
  expect(
    await readFile(path.join(root, "settings.json"), "utf8"),
  ).not.toContain("test-memory-secret");
});

it.each([
  { maxSteps: 0 },
  { idleTimeoutMs: 300001 },
  { requestTimeoutMs: 0 },
  { contextChars: 9999 },
  { baseUrl: "file:///tmp/a" },
  { logLevel: "invalid" },
  { reasoningEffort: "invalid" },
])("rejects invalid settings atomically: %j", async (invalid) => {
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

it("defaults legacy settings to high and persists effort over environment defaults", async () => {
  vi.stubEnv("CODEATELIER_REASONING_EFFORT", "");
  const root = await temp();
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ model: "legacy" }),
  );
  const config = new Config(root);

  expect(config.settings.reasoningEffort).toBe("high");
  vi.stubEnv("CODEATELIER_REASONING_EFFORT", "low");
  expect(new Config(root).settings.reasoningEffort).toBe("low");

  for (const reasoningEffort of ["low", "medium", "high"] as const) {
    config.update({ settings: { ...config.settings, reasoningEffort } });
    expect(new Config(root).settings.reasoningEffort).toBe(reasoningEffort);
  }
});
