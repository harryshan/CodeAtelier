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
