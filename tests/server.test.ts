/**
 * 文件作用：验证本机 HTTP API 的会话隔离、任务状态和写请求鉴权。
 *
 * 使用场景与输入输出：
 * createFixture 组装生产 createApp 与可取消阻塞模型，通过 Fastify inject 检查真实路由及状态。
 *
 * 代码结构与阅读顺序：
 * 1. 夹具先 bootstrap 获取 Cookie/token，供合法请求使用。
 * 2. 会话用例验证隔离、不存在资源及非法 body 的状态码。
 * 3. 并发用例在任务活动期间尝试启动和改设置，再取消并人工恢复。
 * 4. 伪造 token 和异常 Origin 用例验证写入入口的拒绝行为。
 *
 * 维护注意事项：
 * 模拟模型只负责可控等待，路由鉴权和持久化仍走生产实现；阻塞任务须在清理时结束。
 */

import { it, expect } from "vitest";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { createApp } from "../src/server/app.js";
import { temp } from "./fixtures/helpers.js";

async function createFixture() {
  const config = new Config(await temp());
  const fixture = await createApp(config, pino({ enabled: false }), () => ({
    async run(_input, _instructions, _tools, signal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        if (signal.aborted) {
          reject(signal.reason);
        }
      });

      return { output: [], text: "" };
    },
  }));
  const auth = await fixture.app.inject({
    url: "/api/bootstrap",
    headers: { host: "127.0.0.1" },
  });
  const token = auth.json().token;

  return {
    ...fixture,
    config,
    headers: {
      host: "127.0.0.1",
      cookie: "ca_session=" + token,
      "x-codeatelier-token": token,
    },
  };
}

it("creates isolated sessions and validates missing sessions and bad payloads", async () => {
  const fixture = await createFixture();

  try {
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: fixture.headers,
      payload: { workspace: await temp(), title: "api test" },
    });

    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    expect(
      (
        await fixture.app.inject({
          url: "/api/sessions/" + id,
          headers: fixture.headers,
        })
      ).json(),
    ).toMatchObject({ session: { title: "api test" }, tasks: [], events: [] });
    expect(
      (
        await fixture.app.inject({
          url: "/api/sessions/missing",
          headers: fixture.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: `/api/sessions/${id}/tasks`,
          headers: fixture.headers,
          payload: { prompt: " " },
        })
      ).statusCode,
    ).toBe(400);
    expect(fixture.store.tasks(id)).toEqual([]);
  } finally {
    await fixture.app.close();
  }
});

it("blocks concurrent tasks and settings updates, then supports cancellation and resume", async () => {
  const fixture = await createFixture();

  try {
    const session = fixture.store.create(await temp(), "busy");
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/tasks`,
      headers: fixture.headers,
      payload: { prompt: "wait" },
    });

    expect(response.statusCode).toBe(200);
    const id = response.json().id;

    expect(
      (
        await fixture.app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: fixture.headers,
          payload: { settings: fixture.config.settings },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/tasks`,
          headers: fixture.headers,
          payload: { prompt: "another" },
        })
      ).statusCode,
    ).toBe(409);
    await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${id}/cancel`,
      headers: fixture.headers,
      payload: {},
    });
    await fixture.engine.active?.done;

    expect(fixture.store.task(id)?.status).toBe("cancelled");
    const resumed = await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${id}/resume`,
      headers: fixture.headers,
      payload: { instruction: "retry" },
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().id).not.toBe(id);
  } finally {
    await fixture.app.close();
  }
});

it("rejects forged tokens and malformed origins on write endpoints", async () => {
  const fixture = await createFixture();

  try {
    for (const headers of [
      { ...fixture.headers, "x-codeatelier-token": "forged" },
      { ...fixture.headers, origin: "not-a-url" },
      { ...fixture.headers, origin: "file://127.0.0.1" },
    ]) {
      expect(
        (
          await fixture.app.inject({
            method: "POST",
            url: "/api/tasks/missing/resume",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    }

    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: "/api/approvals/missing",
          headers: fixture.headers,
          payload: { decision: "anything" },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await fixture.app.close();
  }
});
