/**
 * 版本化设置的生产集成回归：临时目录、模拟模型与真实鉴权/Engine 调度，不访问真实配置。
 * 1. 新安装与 v1 重开不采用旧环境覆盖；任务快照固定密钥、MCP 和预算。
 * 2. 任务运行中 PATCH 保存成功，旧任务标题/主请求不串配置，下一任务取新值，旧并发设置归一为 0 且重开仍不恢复限制。
 * 3. HTTP 实例初始化和关闭登记到测试作用域，测试提前中断也在删除目录前关闭服务。
 * 4. revision 冲突、非法输入脱敏、门禁待重启及密码验证覆盖 HTTP 边界。
 */
import { it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { createTestApp as createApp } from "./fixtures/managed-runtime.js";
import { temp } from "./fixtures/helpers.js";
import { currentTestResources } from "./fixtures/test-resources.js";

async function configured() {
  const config = new Config(await temp(), { legacy: false });
  await config.updateDocument({
    expectedRevision: (await config.editorValue()).revision,
    changes: {
      models: {
        main: { model: "old-main", baseUrl: "https://example.test/v1" },
        auxiliary: { enabled: true, model: "old-auxiliary" },
      },
    },
    secretChanges: { mainKey: "old-key" },
    mcpChanges: {
      demo: {
        transport: "stdio",
        command: "node",
        env: { TOKEN: "old-mcp-key" },
      },
    },
  });

  return config;
}

afterEach(() => vi.unstubAllEnvs());

it("loads v1 independently of legacy env and preserves keys/MCP in a task snapshot", async () => {
  const config = await configured();
  const snapshot = config.taskSnapshot();
  await config.updateDocument({
    expectedRevision: (await config.editorValue()).revision,
    changes: { models: { main: { model: "new-main" } } },
    secretChanges: { mainKey: "new-key" },
    mcpChanges: { demo: null },
  });
  expect(snapshot.settings.model).toBe("old-main");
  expect(snapshot.modelKey()).toBe("old-key");
  expect(snapshot.modelKey(true)).toBe("old-key");
  expect(snapshot.mcpServers.demo).toBeDefined();
  expect(config.taskSnapshot().modelKey()).toBe("new-key");
  expect(config.errorSecrets()).toContain("old-key");
  expect(config.errorSecrets()).toContain("old-mcp-key");
  vi.stubEnv("CODEATELIER_API_PROTOCOL", "invalid");
  vi.stubEnv("CODEATELIER_TRACE_MAX_RECORDS", "invalid");
  vi.stubEnv("CODEATELIER_SANDBOX_ENABLED", "invalid");
  const reopened = new Config(config.directory, { legacy: false });
  expect(reopened.settings.model).toBe("new-main");
  expect(reopened.modelKey()).toBe("new-key");
  expect(JSON.stringify(await reopened.editorValue())).not.toContain("new-key");
});

it("saves during title generation without mixing task settings and rejects stale writers", async () => {
  const config = await configured();
  const calls: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 超时后的作用域清理也必须解开模拟模型，不能只靠正文 finally。
  currentTestResources().signal.addEventListener("abort", release, {
    once: true,
  });
  const fixture = await createApp(
    config,
    pino({ enabled: false }),
    (settings, purpose) => ({
      async run() {
        calls.push(`${purpose}:${settings.model}`);
        if (purpose === "auxiliary") {
          await waiting;
        }

        return {
          output: [],
          text: purpose === "auxiliary" ? "测试标题" : "完成",
        };
      },
    }),
  );
  try {
    const token = (await fixture.app.inject({ url: "/api/bootstrap" })).json()
      .token;
    const headers = {
      cookie: `ca_session=${token}`,
      "x-codeatelier-token": token,
    };
    const session = await fixture.store.create(await temp());
    const task = await fixture.engine.start(session.id, "任务一");
    await expect.poll(() => calls.length).toBe(1);
    const view = await config.editorValue();
    const payload = {
      expectedRevision: view.revision,
      changes: {
        models: {
          main: { model: "new-main" },
          auxiliary: { model: "new-auxiliary" },
        },
        execution: { maxConcurrentTasks: 1 },
      },
      secretChanges: { mainKey: "new-key" },
    };
    const saved = await fixture.app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers,
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("new-key");
    expect(config.settings.maxConcurrentTasks).toBe(0);
    expect(
      (await config.editorValue()).configuration.execution.maxConcurrentTasks,
    ).toBe(0);
    expect(
      new Config(config.directory, { legacy: false }).settings
        .maxConcurrentTasks,
    ).toBe(0);
    const conflict = await fixture.app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers,
      payload,
    });
    expect(conflict.statusCode).toBe(409);
    release();
    await expect
      .poll(async () => (await fixture.store.task(task.id))?.status)
      .toBe("completed");
    const next = await fixture.engine.start(session.id, "任务二");
    await expect
      .poll(async () => (await fixture.store.task(next.id))?.status)
      .toBe("completed");
    expect(calls).toEqual([
      "auxiliary:old-auxiliary",
      "task:old-main",
      "task:new-main",
    ]);
    const invalid = await fixture.app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers,
      payload: {
        expectedRevision: (await config.editorValue()).revision,
        secretChanges: { mainKey: { raw: "not-to-be-returned" } },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("not-to-be-returned");
  } finally {
    release();
    await fixture.app.close();
  }
});

it("allows onboarding without model credentials and enables saved password only after restart", async () => {
  const config = new Config(await temp(), { legacy: false });
  const fixture = await createApp(config, pino({ enabled: false }));
  try {
    const session = await fixture.store.create(await temp());
    await expect(
      fixture.engine.start(session.id, "未配置任务"),
    ).rejects.toThrow("主模型");
    await config.updateDocument({
      expectedRevision: (await config.editorValue()).revision,
      changes: { server: { passwordEnabled: true } },
      secretChanges: { password: "private-password" },
    });
    expect(
      (await fixture.app.inject({ url: "/api/access/status" })).json().enabled,
    ).toBe(false);
    expect((await config.editorValue()).pendingRestart).toContain("server");
  } finally {
    await fixture.app.close();
  }

  const reopened = await createApp(
    new Config(config.directory, { legacy: false }),
    pino({ enabled: false }),
  );
  try {
    expect(
      (await reopened.app.inject({ url: "/api/bootstrap" })).statusCode,
    ).toBe(401);
    expect(
      (
        await reopened.app.inject({
          method: "POST",
          url: "/api/access/login",
          payload: { password: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await reopened.app.inject({
          method: "POST",
          url: "/api/access/login",
          payload: { password: "private-password" },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await reopened.app.close();
  }
});
