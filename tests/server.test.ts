/**
 * 通过 Fastify inject 检查真实 HTTP 路由的会话隔离、任务状态和鉴权。
 * createFixture 使用 createApp、临时数据库和可取消的等待模型。
 *
 * 1. 测试夹具通过 bootstrap 获取合法 Cookie 和 token。
 * 2. 检查不同会话的数据隔离，以及资源不存在和请求体非法时的状态码。
 * 3. 检查不同工作区可并行、同工作区排队、全局上限与设置互斥，再检查取消与人工恢复。
 * 4. 用伪造 token 和异常 Origin 检查写请求被拒绝。
 *
 * 模型只用来控制任务何时结束；鉴权和保存都走真实代码，清理时也要结束等待中的任务。
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
      payload: { workspace: await temp() },
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
    ).toMatchObject({
      session: { title: "新对话", titleState: "pending" },
      tasks: [],
      events: [],
    });
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

it("returns only events after the snapshot cursor while keeping current session state", async () => {
  const fixture = await createFixture();

  try {
    const session = fixture.store.create(await temp());
    const first = fixture.store.event(session.id, "task-one", "notice", {
      text: "first event",
    });
    const second = fixture.store.event(session.id, "task-one", "notice", {
      text: "second event",
    });
    const response = await fixture.app.inject({
      url: `/api/sessions/${session.id}?after=${first.id}`,
      headers: fixture.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session: { id: session.id },
      tasks: [],
      approvals: [],
      events: [{ id: second.id, data: { text: "second event" } }],
    });
    expect(
      (
        await fixture.app.inject({
          url: `/api/sessions/${session.id}?after=-1`,
          headers: fixture.headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await fixture.app.close();
  }
});

it("runs different workspaces in parallel while queueing the same workspace", async () => {
  const fixture = await createFixture();

  try {
    const sharedWorkspace = await temp();
    const firstSession = fixture.store.create(sharedWorkspace, "first");
    const sameWorkspaceSession = fixture.store.create(sharedWorkspace, "same");
    const otherSession = fixture.store.create(await temp(), "other");
    const start = async (sessionId: string, prompt: string) =>
      fixture.app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/tasks`,
        headers: fixture.headers,
        payload: { prompt },
      });

    const first = await start(firstSession.id, "first task");
    expect(first.statusCode).toBe(200);
    const firstTaskId = first.json().id;
    expect(() => fixture.engine.start(firstSession.id, "same session")).toThrow(
      "当前会话已有",
    );

    const queued = await start(sameWorkspaceSession.id, "same workspace task");
    expect(queued.statusCode).toBe(200);
    const queuedTaskId = queued.json().id;
    expect(queued.json().status).toBe("queued");

    const other = await start(otherSession.id, "other workspace task");
    expect(other.statusCode).toBe(200);
    const otherTaskId = other.json().id;
    expect(other.json().status).toBe("running");
    expect(fixture.engine.activeTasks).toHaveLength(2);
    expect(fixture.store.task(queuedTaskId)?.status).toBe("queued");

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

    await fixture.app.inject({
      method: "POST",
      url: `/api/tasks/${firstTaskId}/cancel`,
      headers: fixture.headers,
      payload: {},
    });
    await expect
      .poll(() => fixture.store.task(queuedTaskId)?.status)
      .toBe("running");

    for (const taskId of [queuedTaskId, otherTaskId]) {
      await fixture.app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/cancel`,
        headers: fixture.headers,
        payload: {},
      });
    }

    await expect.poll(() => fixture.engine.hasActiveTasks).toBe(false);
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
