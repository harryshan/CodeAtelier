/**
 * 显式设置迁移的离线回归，只使用合成 dotenv、临时旧偏好和候选文件。
 * 1. 默认预检不写设置，写候选与激活分开，并保留旧连接优先级/偏好及原件。
 * 2. 冲突、未知字段和缺少停止确认拒绝迁移，异常不包含凭据值。
 * 本文件不调用真实模型、服务或用户配置，也不执行 Evaluation。
 */
import { it, expect } from "vitest";
import { writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  createSettingsCandidate,
  activateSettingsCandidate,
  inspectLegacyEnvironment,
} from "../src/config/migrate-settings.js";
import { Config } from "../src/config/config.js";
import { temp } from "./fixtures/helpers.js";

it("preflights then writes a private candidate and explicitly activates without deleting sources", async () => {
  const directory = await temp();
  const envFile = path.join(directory, "legacy.env");
  const dotenv =
    "CODEATELIER_BASE_URL=https://example.test/v1\nCODEATELIER_MODEL=legacy-env-model\nCODEATELIER_API_KEY=synthetic-secret\n";
  const old = '{"maxSteps":42,"model":"ignored-old-model"}';
  await writeFile(envFile, dotenv);
  await writeFile(path.join(directory, "settings.json"), old);
  const preview = await createSettingsCandidate(directory, envFile, false, {});
  expect(preview.mode).toBe("preflight-only");
  expect((await readdir(directory)).length).toBe(2);
  const candidate = await createSettingsCandidate(directory, envFile, true, {});
  expect(await readFile(path.join(directory, "settings.json"), "utf8")).toBe(
    old,
  );
  await expect(
    activateSettingsCandidate(directory, candidate.candidatePath!, false),
  ).rejects.toThrow("停止服务");
  await activateSettingsCandidate(directory, candidate.candidatePath!, true);
  const config = new Config(directory, { legacy: false });
  expect(config.settings.model).toBe("legacy-env-model");
  expect(config.settings.maxSteps).toBe(42);
  expect(config.modelKey()).toBe("synthetic-secret");
  expect(await readFile(envFile, "utf8")).toBe(dotenv);
  await expect(
    activateSettingsCandidate(directory, candidate.candidatePath!, true),
  ).rejects.toThrow("重复迁移");
});

it("reports conflicts by name without revealing values", async () => {
  const inspection = inspectLegacyEnvironment(
    "CODEATELIER_API_KEY=private-one\nCODEATELIER_UNKNOWN=value",
    { CODEATELIER_API_KEY: "private-two" },
  );
  expect(inspection.conflicts).toEqual(["CODEATELIER_API_KEY"]);
  expect(inspection.unknown).toEqual(["CODEATELIER_UNKNOWN"]);
  const directory = await temp();
  const file = path.join(directory, "legacy.env");
  await writeFile(file, "CODEATELIER_API_KEY=private-one");
  const promise = createSettingsCandidate(directory, file, false, {
    CODEATELIER_API_KEY: "private-two",
  });
  await expect(promise).rejects.toThrow("环境冲突：CODEATELIER_API_KEY");
  await expect(promise).rejects.not.toThrow("private-one");
});
