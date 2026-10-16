/**
 * 用临时目录检验版本化配置的事务、公开投影和文件安全，不读取真实 env 或连接模型。
 * 1. 新安装默认值、保存重开和私有权限，验证密钥、MCP 参数和密码材料不回传。
 * 2. 同 revision 并发更新、外部漂移、坏文件和写失败必须保留已发布状态。
 * 3. 连接变更确认、辅助密钥隔离、旧配置显式迁移及密码校验覆盖安全边界。
 * 4. 主/辅助关闭思考在保存重开及运行时投影后保留 none，非法等级不改变配置。
 * Windows 使用实际 DACL 写读路径；测试只接触 helpers 创建的可清理临时目录。
 */
import { it, expect } from "vitest";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { SettingsStore } from "../src/config/settings-store.js";
import {
  defaultDocument,
  runtimeSettings,
} from "../src/config/settings-document.js";
import { settingsSchema } from "../src/config/settings.js";
import { auxiliarySettings } from "../src/config/auxiliary-model.js";
import { verifyPassword } from "../src/config/password.js";
import { temp } from "./fixtures/helpers.js";

it("saves private settings, hides credentials and reopens without environment configuration", async () => {
  const directory = await temp();
  const store = new SettingsStore(directory);
  expect(store.view().configuration.models.main.model).toBe("");
  await store.update({
    expectedRevision: store.view().revision,
    changes: {
      models: {
        main: { model: "demo", baseUrl: "https://model.example/v1/responses" },
      },
      server: { passwordEnabled: true },
    },
    secretChanges: {
      mainKey: "private-model-key",
      password: "private-password",
    },
    mcpChanges: {
      demo: {
        transport: "stdio",
        command: "private-command",
        args: ["private-argument"],
        env: { TOKEN: "private-mcp-key" },
      },
    },
  });
  const publicText = JSON.stringify(store.view());
  for (const secret of [
    "private-model-key",
    "private-password",
    "private-command",
    "private-argument",
    "private-mcp-key",
    "scrypt:",
  ]) {
    expect(publicText).not.toContain(secret);
  }

  const reopened = new SettingsStore(directory);
  expect(reopened.document.models.main.apiKey).toBe("private-model-key");
  expect(reopened.document.models.main.baseUrl).toBe(
    "https://model.example/v1",
  );
  expect(
    await verifyPassword(
      "private-password",
      reopened.document.server.passwordHash,
    ),
  ).toBe(true);
  expect(
    await verifyPassword("wrong", reopened.document.server.passwordHash),
  ).toBe(false);
  expect(store.view().pendingRestart).toContain("server");
  expect(reopened.view().pendingRestart).toEqual([]);
});

it("persists disabled reasoning for main and auxiliary models without changing defaults", async () => {
  const directory = await temp();
  const store = new SettingsStore(directory);
  expect(store.document.models.main.reasoningEffort).toBe("high");
  expect(store.document.models.auxiliary.reasoningEffort).toBe("low");

  await store.update({
    expectedRevision: store.view().revision,
    changes: {
      models: {
        main: {
          model: "main-fixture",
          baseUrl: "https://model.example/v1",
          reasoningEffort: "none",
        },
        auxiliary: {
          enabled: true,
          model: "aux-fixture",
          reasoningEffort: "none",
        },
      },
    },
  });

  const reopened = new SettingsStore(directory);
  expect(reopened.view().configuration.models.main.reasoningEffort).toBe(
    "none",
  );
  expect(reopened.view().configuration.models.auxiliary.reasoningEffort).toBe(
    "none",
  );
  const settings = settingsSchema.parse(runtimeSettings(reopened.document));
  expect(settings.reasoningEffort).toBe("none");
  expect(auxiliarySettings(settings).reasoningEffort).toBe("none");

  const before = reopened.view();
  for (const model of ["main", "auxiliary"]) {
    await expect(
      reopened.update({
        expectedRevision: before.revision,
        changes: { models: { [model]: { reasoningEffort: "invalid" } } },
      }),
    ).rejects.toThrow("格式无效");
    expect(reopened.view()).toEqual(before);
  }
});

it("serializes concurrent saves and rejects stale revision and external drift", async () => {
  const store = new SettingsStore(await temp());
  const revision = store.view().revision;
  const results = await Promise.allSettled([
    store.update({
      expectedRevision: revision,
      changes: { execution: { maxSteps: 21 } },
    }),
    store.update({
      expectedRevision: revision,
      changes: { execution: { maxSteps: 22 } },
    }),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(store.document.execution.maxSteps).toBe(21);
  const text = await readFile(store.file, "utf8");
  await writeFile(store.file, text + " ");
  await expect(
    store.update({ expectedRevision: store.view().revision }),
  ).rejects.toThrow("配置已变化");
  await store.reload(store.view().revision);
  expect(store.document.execution.maxSteps).toBe(21);
});

it("keeps memory and corrupt files unchanged on validation or write failure", async () => {
  const store = new SettingsStore(await temp());
  const before = store.view();
  await expect(
    store.update({
      expectedRevision: before.revision,
      changes: { execution: { maxSteps: 0 } },
      secretChanges: { mainKey: "secret-input" },
    }),
  ).rejects.toThrow("格式无效");
  expect(store.view()).toEqual(before);
  await mkdir(store.file);
  await expect(
    store.update({ expectedRevision: before.revision }),
  ).rejects.toThrow();
  expect(store.view()).toEqual(before);
  const directory = await temp();
  const file = path.join(directory, "settings.json");
  await writeFile(file, "corrupt-secret-json");
  expect(() => new SettingsStore(directory)).toThrow();
  expect(await readFile(file, "utf8")).toBe("corrupt-secret-json");
});

it("requires key replacement on target changes and rejects cross-endpoint inheritance", async () => {
  const store = new SettingsStore(await temp());
  await store.update({
    expectedRevision: store.view().revision,
    changes: {
      models: { main: { baseUrl: "https://first.example/v1", model: "demo" } },
    },
    secretChanges: { mainKey: "old-key" },
  });
  await expect(
    store.update({
      expectedRevision: store.view().revision,
      changes: { models: { main: { baseUrl: "https://second.example/v1" } } },
    }),
  ).rejects.toThrow("重新输入");
  await expect(
    store.update({
      expectedRevision: store.view().revision,
      changes: {
        models: {
          auxiliary: {
            enabled: true,
            model: "small",
            inheritConnection: false,
            baseUrl: "https://other.example",
          },
        },
      },
    }),
  ).rejects.toThrow("校验失败");
  await store.update({
    expectedRevision: store.view().revision,
    secretChanges: { mainKey: "" },
  });
  expect(store.document.models.main.apiKey).toBe("");
});

it("migrates only after confirmation and retains the original as a private backup", async () => {
  const directory = await temp();
  const oldText = '{"maxSteps":42}';
  await writeFile(path.join(directory, "settings.json"), oldText);
  const seed = defaultDocument();
  seed.execution.maxSteps = 42;
  const store = new SettingsStore(directory, seed);
  await expect(
    store.update({ expectedRevision: store.view().revision }),
  ).rejects.toThrow("显式确认迁移");
  expect(await readFile(store.file, "utf8")).toBe(oldText);
  await store.update({
    expectedRevision: store.view().revision,
    confirmMigration: true,
  });
  const backup = (await readdir(directory)).find((name) =>
    name.includes("pre-v1"),
  )!;
  expect(await readFile(path.join(directory, backup), "utf8")).toBe(oldText);
  expect(new SettingsStore(directory).document.execution.maxSteps).toBe(42);
});

it("keeps omitted custom fields across partial saves and isolates an inherited auxiliary key", async () => {
  const store = new SettingsStore(await temp());
  await store.update({
    expectedRevision: store.view().revision,
    changes: {
      models: {
        main: {
          baseUrl: "https://first.example/v1",
          model: "large",
          reasoningEffort: "low",
        },
        auxiliary: { enabled: true, model: "small" },
      },
      execution: { maxSteps: 37, outputChars: 4500 },
    },
    secretChanges: { mainKey: "main-test-key", auxiliaryKey: "aux-test-key" },
  });
  await store.update({
    expectedRevision: store.view().revision,
    changes: {
      execution: { maxSteps: 39 },
      models: { main: { model: "large-next" } },
    },
  });
  expect(store.document.execution.outputChars).toBe(4500);
  expect(store.document.models.main.reasoningEffort).toBe("low");
  expect(store.document.models.auxiliary.enabled).toBe(true);
  await expect(
    store.update({
      expectedRevision: store.view().revision,
      changes: { models: { main: { baseUrl: "https://second.example/v1" } } },
      secretChanges: { mainKey: "replacement-key" },
    }),
  ).rejects.toThrow("重新输入");
});

it("fails closed on a stale writer lock until explicit lock removal", async () => {
  const store = new SettingsStore(await temp());
  await store.update({ expectedRevision: store.view().revision });
  const original = await readFile(store.file, "utf8");
  const lock = store.file + ".write-lock";
  await writeFile(lock, "");
  await expect(
    store.update({
      expectedRevision: store.view().revision,
      changes: { execution: { maxSteps: 41 } },
    }),
  ).rejects.toThrow("写入锁");
  expect(await readFile(store.file, "utf8")).toBe(original);
  await rm(lock);
  await store.update({
    expectedRevision: store.view().revision,
    changes: { execution: { maxSteps: 41 } },
  });
  expect(
    new SettingsStore(path.dirname(store.file)).document.execution.maxSteps,
  ).toBe(41);
});
