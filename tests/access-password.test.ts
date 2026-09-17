/**
 * 通过真实 Fastify 注入验证环境驱动的 Web 访问密码门禁。
 * 测试创建临时 Config、SQLite 与生产 createApp，不启动浏览器或模型任务；每例结束后恢复环境变量并关闭应用。
 *
 * 1. disabledAccessFixture 验证默认关闭时状态接口允许继续 bootstrap。
 * 2. protectedAccessFixture 设置显式环境密码，检查未验证 API、错误密码和正确密码 cookie 的可观察结果。
 * 3. 无效开关和启用时缺少密码必须在应用创建前失败，避免静默暴露页面。
 *
 * 用例只传入模拟密码，断言响应与 cookie 中不含密码；不会读取真实 .env 或连接外部模型服务。
 */

import { afterEach, expect, it, vi } from "vitest";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { createApp } from "../src/server/app.js";
import { temp } from "./fixtures/helpers.js";

afterEach(() => vi.unstubAllEnvs());

async function accessFixture() {
  const config = new Config(await temp());
  const fixture = await createApp(config, pino({ enabled: false }));

  return { ...fixture, config };
}

function firstCookie(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;

  if (!header) {
    throw new Error("Expected an access cookie.");
  }

  return header.split(";", 1)[0];
}

it("keeps the password gate disabled by default", async () => {
  vi.stubEnv("CODEATELIER_WEB_PASSWORD_ENABLED", "false");
  vi.stubEnv("CODEATELIER_WEB_PASSWORD", "");
  const fixture = await accessFixture();

  try {
    const status = await fixture.app.inject({
      url: "/api/access/status",
      headers: { host: "127.0.0.1" },
    });
    const bootstrap = await fixture.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    });

    expect(status.json()).toEqual({ enabled: false, authenticated: true });
    expect(bootstrap.statusCode).toBe(200);
  } finally {
    await fixture.app.close();
  }
});

it("requires the configured password before allowing bootstrap and protected APIs", async () => {
  vi.stubEnv("CODEATELIER_WEB_PASSWORD_ENABLED", "true");
  vi.stubEnv("CODEATELIER_WEB_PASSWORD", "test-access-password");
  const fixture = await accessFixture();

  try {
    const guest = await fixture.app.inject({
      url: "/api/access/status",
      headers: { host: "127.0.0.1" },
    });
    const blocked = await fixture.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    });
    const rejected = await fixture.app.inject({
      method: "POST",
      url: "/api/access/login",
      headers: { host: "127.0.0.1" },
      payload: { password: "incorrect-password" },
    });
    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/api/access/login",
      headers: { host: "127.0.0.1" },
      payload: { password: "test-access-password" },
    });
    const accessCookie = firstCookie(accepted.headers["set-cookie"]);
    const bootstrap = await fixture.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1", cookie: accessCookie },
    });
    const sessionToken = bootstrap.json().token as string;
    const sessions = await fixture.app.inject({
      url: "/api/sessions",
      headers: {
        host: "127.0.0.1",
        cookie: `${accessCookie}; ca_session=${sessionToken}`,
      },
    });

    expect(guest.json()).toEqual({ enabled: true, authenticated: false });
    expect(blocked.statusCode).toBe(401);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain("test-access-password");
    expect(accepted.statusCode).toBe(200);
    expect(accessCookie).toMatch(/^ca_access=/);
    expect(accepted.headers["set-cookie"]).toContain("HttpOnly");
    expect(accepted.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(bootstrap.statusCode).toBe(200);
    expect(sessions.statusCode).toBe(200);
  } finally {
    await fixture.app.close();
  }
});

it.each([
  [
    "enabled value is invalid",
    "yes",
    "password",
    "CODEATELIER_WEB_PASSWORD_ENABLED",
  ],
  ["enabled without a password", "true", "", "CODEATELIER_WEB_PASSWORD"],
])("rejects startup when %s", async (_name, enabled, password, message) => {
  vi.stubEnv("CODEATELIER_WEB_PASSWORD_ENABLED", enabled);
  vi.stubEnv("CODEATELIER_WEB_PASSWORD", password);
  const config = new Config(await temp());

  await expect(createApp(config, pino({ enabled: false }))).rejects.toThrow(
    message,
  );
});
