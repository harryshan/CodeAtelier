import { it, expect } from "vitest";
import pino from "pino";
import { Config } from "../src/config/settings.js";
import { createApp } from "../src/server/app.js";
import { temp } from "./fixtures/helpers.js";
async function fixture() {
  const config = new Config(await temp());
  const f = await createApp(config, pino({ enabled: false }), () => ({
    async run(_input, _instructions, _tools, signal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        if (signal.aborted) reject(signal.reason);
      });
      return { output: [], text: "" };
    },
  }));
  const auth = await f.app.inject({
    url: "/api/bootstrap",
    headers: { host: "127.0.0.1" },
  });
  const token = auth.json().token;
  return {
    ...f,
    config,
    headers: {
      host: "127.0.0.1",
      cookie: "ca_session=" + token,
      "x-codeatelier-token": token,
    },
  };
}
it("creates isolated sessions and validates missing sessions and bad payloads", async () => {
  const f = await fixture();
  try {
    const created = await f.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: f.headers,
      payload: { workspace: await temp(), title: "api test" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect(
      (
        await f.app.inject({ url: "/api/sessions/" + id, headers: f.headers })
      ).json(),
    ).toMatchObject({ session: { title: "api test" }, tasks: [], events: [] });
    expect(
      (await f.app.inject({ url: "/api/sessions/missing", headers: f.headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/sessions/${id}/tasks`,
          headers: f.headers,
          payload: { prompt: " " },
        })
      ).statusCode,
    ).toBe(400);
    expect(f.store.tasks(id)).toEqual([]);
  } finally {
    await f.app.close();
  }
});
it("blocks concurrent tasks and settings updates, then supports cancellation and resume", async () => {
  const f = await fixture();
  try {
    const session = f.store.create(await temp(), "busy");
    const response = await f.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/tasks`,
      headers: f.headers,
      payload: { prompt: "wait" },
    });
    expect(response.statusCode).toBe(200);
    const id = response.json().id;
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: f.headers,
          payload: { settings: f.config.settings },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/tasks`,
          headers: f.headers,
          payload: { prompt: "another" },
        })
      ).statusCode,
    ).toBe(409);
    await f.app.inject({
      method: "POST",
      url: `/api/tasks/${id}/cancel`,
      headers: f.headers,
      payload: {},
    });
    await f.engine.active?.done;
    expect(f.store.task(id)?.status).toBe("cancelled");
    const resumed = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${id}/resume`,
      headers: f.headers,
      payload: { instruction: "retry" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().id).not.toBe(id);
  } finally {
    await f.app.close();
  }
});
it("rejects forged tokens and malformed origins on write endpoints", async () => {
  const f = await fixture();
  try {
    for (const headers of [
      { ...f.headers, "x-codeatelier-token": "forged" },
      { ...f.headers, origin: "not-a-url" },
      { ...f.headers, origin: "file://127.0.0.1" },
    ])
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/tasks/missing/resume",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/approvals/missing",
          headers: f.headers,
          payload: { decision: "anything" },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await f.app.close();
  }
});
