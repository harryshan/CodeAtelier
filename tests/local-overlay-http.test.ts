/**
 * Local overlay 的 HTTP 契约回归，使用生产 Fastify/Engine/Store/清单和临时目录。
 * 1. 挂载由 FakeLocalOverlayBackend 替代，允许开关仅在正例替换；鉴权、互斥参数和缺能力拒绝均走真实路由。
 * 2. 固定 UUID 创建/重试、来源身份、列表/快照/历史分页及损坏清单的历史可读性。
 * 3. 冲突参数与源目录更换不创建额外视图；关闭 Sandbox 后旧视图启动/恢复也须拒绝，不调度 Runtime 或宣称真实 WinFsp/Sandbox 可用。
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import { createTestApp } from "./fixtures/managed-runtime.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { temp } from "./fixtures/helpers.js";

async function fixture() {
  const config = new Config(await temp());
  const backend = new FakeLocalOverlayBackend(await temp());
  const server = await createTestApp(
    config,
    pino({ enabled: false }),
    undefined,
    undefined,
    undefined,
    false,
    backend,
  );
  const bootstrap = (
    await server.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    })
  ).json();
  const headers = {
    host: "127.0.0.1",
    cookie: `ca_session=${bootstrap.token}`,
    "x-codeatelier-token": bootstrap.token,
  };

  return { ...server, backend, headers, source: await temp() };
}

it("requires authorization and creation capability before allocating a view", async () => {
  const f = await fixture();
  const payload = { workspace: f.source, localOverlay: { id: randomUUID() } };
  expect(
    (await f.app.inject({ method: "POST", url: "/api/sessions", payload }))
      .statusCode,
  ).toBe(401);
  const csrf = await f.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { host: f.headers.host, cookie: f.headers.cookie },
    payload,
  });
  expect(csrf.statusCode).toBe(403);
  const denied = await f.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: f.headers,
    payload,
  });
  expect(denied.statusCode).toBe(409);
  expect(denied.json().error).toMatch(/Sandbox|Windows/);
  expect(f.backend.creates).toBe(0);
  expect(await f.store.list()).toHaveLength(0);
});

it("creates a non-Git Local view idempotently and projects status on every history route", async () => {
  const f = await fixture();
  vi.spyOn(f.engine, "localOverlayCreation", "get").mockReturnValue({
    enabled: true,
  });
  const id = randomUUID();
  const payload = { workspace: f.source, localOverlay: { id } };
  const create = () =>
    f.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: f.headers,
      payload,
    });
  const response = await create();
  expect(response.statusCode).toBe(200);
  const session = response.json();
  expect(session.localOverlay).toMatchObject({
    id,
    projectWorkspace: f.source,
    state: "ready",
  });
  expect(session.worktree).toBeUndefined();
  expect(session.workspace).not.toBe(f.source);
  expect((await create()).json().id).toBe(session.id);
  expect(f.backend.creates).toBe(1);
  expect(f.backend.mounted.size).toBe(0);
  for (const suffix of ["", "?before=1"]) {
    const snapshot = (
      await f.app.inject({
        url: `/api/sessions/${session.id}${suffix}`,
        headers: f.headers,
      })
    ).json();
    expect(snapshot.session.localOverlay).toEqual(session.localOverlay);
  }

  const list = (
    await f.app.inject({ url: "/api/sessions", headers: f.headers })
  ).json();
  expect(list[0].localOverlay).toEqual(session.localOverlay);
  const mismatched = await f.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: f.headers,
    payload: { ...payload, workspace: await temp() },
  });
  expect(mismatched.statusCode).toBe(409);
  expect(f.backend.creates).toBe(1);
  await writeFile(
    path.join(f.engine.localOverlays.root, `${id}.json`),
    "invalid manifest",
  );
  const history = (
    await f.app.inject({
      url: `/api/sessions/${session.id}`,
      headers: f.headers,
    })
  ).json();
  expect(history.session.localOverlay).toEqual({ id, state: "unavailable" });
  expect(history.session.workspace).toBe(session.workspace);
});

it.each([
  { riftri: { id: randomUUID() } },
  { worktree: { id: randomUUID(), baseRef: "HEAD" } },
  { localOverlay: { id: randomUUID(), baseRef: "HEAD" } },
])("rejects mixed modes or a Local Git base (%j)", async (extra) => {
  const f = await fixture();
  const result = await f.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: f.headers,
    payload: {
      workspace: f.source,
      localOverlay: { id: randomUUID() },
      ...extra,
    },
  });
  expect(result.statusCode).toBe(400);
  expect(f.backend.creates).toBe(0);
});

it("rejects starting and resuming an existing Local view when Sandbox is disabled", async () => {
  const f = await fixture();
  const availability = vi
    .spyOn(f.engine, "localOverlayCreation", "get")
    .mockReturnValue({ enabled: true });
  const response = await f.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: f.headers,
    payload: { workspace: f.source, localOverlay: { id: randomUUID() } },
  });
  expect(response.statusCode).toBe(200);
  const session = response.json();
  const { task } = await f.store.startTaskAsync(
    session.id,
    "retained work",
    false,
  );
  await f.store.statusAsync(task.id, "interrupted");
  availability.mockRestore();

  for (const [url, payload] of [
    [`/api/sessions/${session.id}/tasks`, { prompt: "continue" }],
    [`/api/tasks/${task.id}/resume`, { instruction: "continue" }],
  ] as const) {
    const denied = await f.app.inject({
      method: "POST",
      url,
      headers: f.headers,
      payload,
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toMatch(/Sandbox|Windows/);
  }

  expect(await f.store.tasks(session.id)).toHaveLength(1);
  expect((await f.store.task(task.id))?.status).toBe("interrupted");
  expect(f.backend.mounted.size).toBe(0);
});
