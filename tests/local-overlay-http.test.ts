/**
 * Local overlay 的 HTTP 契约回归，使用生产 Fastify/Engine/Store/清单和临时目录。
 * 1. 挂载由 FakeLocalOverlayBackend 替代，允许开关仅在正例替换；鉴权、互斥参数和缺能力拒绝均走真实路由。
 * 2. 固定 UUID 创建/重试、来源身份、列表/快照/历史分页及损坏清单的历史可读性。
 * 3. 冲突参数与源目录更换不创建额外视图；关闭 Sandbox 后旧视图启动/恢复也须拒绝，不调度 Runtime 或宣称真实 WinFsp/Sandbox 可用。
 * 4. 单文件及整组检查走真实 SQLite 与服务锁，验证鉴权、材料版本、脏卷拒绝及受控错误；检查不挂载，新对话不自动运行。
 * 5. 中断接口用明确标记的服务材料替身验证 HTTP 状态/参数和创建门禁；不将此夹具作为原生退出证明。
 * 6. 完成态刷新使用服务替身验证鉴权、空参数、能力门禁、状态回读和无自动任务；原生恢复由专项实机验证。
 * 7. 本套件显式替换代码开关为开启；默认关闭及无副作用拒绝由 local-overlay-readiness.test.ts 验证。
 */
import { randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import { createTestApp } from "./fixtures/managed-runtime.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { temp } from "./fixtures/helpers.js";
import { nativeFixture } from "./fixtures/local-overlay-native.js";

// 显式开启此套件的功能契约，生产默认关闭由 readiness 套件独立验证。
vi.mock("../src/local-overlays/readiness.js", async (original) => ({
  ...(await original<typeof import("../src/local-overlays/readiness.js")>()),
  LOCAL_OVERLAY_ENABLED: true,
  requireLocalOverlayEnabled() {},
}));

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

it("protects explicit private refresh and returns updated history without starting a task", async () => {
  const f = await fixture();
  const id = randomUUID();
  const session = await f.engine.localOverlays.create(
    { id, source: f.source },
    (workspace) => f.store.create(workspace, "Refresh"),
  );
  const url = `/api/sessions/${session.id}/local-refresh`;
  const send = (headers = f.headers, payload = {}) =>
    f.app.inject({ method: "POST", url, headers, payload });
  expect((await send({} as typeof f.headers)).statusCode).toBe(401);
  expect(
    (
      await send({
        host: f.headers.host,
        cookie: f.headers.cookie,
      } as typeof f.headers)
    ).statusCode,
  ).toBe(403);
  expect((await send()).statusCode).toBe(409);
  vi.spyOn(f.engine, "localOverlayCreation", "get").mockReturnValue({
    enabled: true,
  });
  expect((await send(f.headers, { source: f.source })).statusCode).toBe(400);
  const recover = vi
    .spyOn(f.engine.localOverlays, "recoverPrivateRefresh")
    .mockRejectedValueOnce(new Error("private internal detail"));
  const failure = await send();
  expect(failure.statusCode).toBe(409);
  expect(failure.body).not.toContain("private internal detail");
  recover.mockResolvedValueOnce({ recovered: true });
  const response = await send();
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json().id).toBe(session.id);
  expect(response.json().localOverlay.state).toBe("ready");
  expect(await f.store.tasks(session.id)).toHaveLength(0);
  expect(recover).toHaveBeenCalledWith(
    session.workspace,
    session.id,
    expect.any(AbortSignal),
  );
  await f.shutdown();
});

it("requires explicit interrupted requests and preserves failed state while creating a reference session", async () => {
  const f = await fixture();
  const id = randomUUID();
  const parent = await f.engine.localOverlays.create(
    { id, source: f.source },
    (workspace) => f.store.create(workspace, "Interrupted"),
  );
  const manifest = path.join(f.engine.localOverlays.root, `${id}.json`);
  const record = JSON.parse(await readFile(manifest, "utf8"));
  record.phase = "failed";
  await writeFile(manifest, JSON.stringify(record));
  const bytes = {
    content: Buffer.from("partial").toString("base64"),
    version: "fixture",
    mode: null,
  };
  const material = {
    state: "interrupted" as const,
    publicationChecked: false as const,
    version: "a".repeat(64),
    files: [{ path: "code.txt", base: bytes, private: bytes }],
  };
  const inspect = vi
    .spyOn(f.engine.localOverlays, "reviewInterrupted")
    .mockResolvedValue(material);
  const url = `/api/sessions/${parent.id}/local-review`;
  const payload = { paths: ["code.txt"], state: "interrupted" };
  expect(
    (await f.app.inject({ method: "POST", url, payload })).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        payload,
        headers: { host: f.headers.host, cookie: f.headers.cookie },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        payload: { paths: ["code.txt"] },
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
  for (const invalid of [
    { ...payload, control: "untrusted" },
    { path: "code.txt", state: "interrupted" },
    { ...payload, state: "ready" },
  ]) {
    expect(
      (
        await f.app.inject({
          method: "POST",
          url,
          payload: invalid,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(400);
  }

  const result = await f.app.inject({
    method: "POST",
    url,
    payload,
    headers: f.headers,
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.json()).toEqual(material);
  const continuation = {
    ...payload,
    id: randomUUID(),
    version: material.version,
  };
  const continueUrl = `/api/sessions/${parent.id}/local-resolution`;
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: continueUrl,
        payload: continuation,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
  vi.spyOn(f.engine, "localOverlayCreation", "get").mockReturnValue({
    enabled: true,
  });
  const child = await f.app.inject({
    method: "POST",
    url: continueUrl,
    payload: continuation,
    headers: f.headers,
  });
  expect(child.statusCode).toBe(200);
  expect(child.json().localOverlay.resolution.state).toBe("interrupted");
  expect(await f.store.tasks(child.json().id)).toHaveLength(0);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: continueUrl,
        payload: continuation,
        headers: f.headers,
      })
    ).json().id,
  ).toBe(child.json().id);
  expect(JSON.parse(await readFile(manifest, "utf8"))).toEqual(record);
  inspect.mockRejectedValueOnce(
    new Error("private SQLite path and process detail"),
  );
  const rejected = await f.app.inject({
    method: "POST",
    url,
    payload,
    headers: f.headers,
  });
  expect(rejected.statusCode).toBe(409);
  expect(rejected.body).toContain("原卷、锁及未知状态保持不变");
  expect(rejected.body).not.toContain("SQLite");
});

it("reviews selected files with authentication without exposing control paths or mounting", async () => {
  const f = await fixture();
  const native = await nativeFixture();
  await native.change("code.txt", "base", "private");
  native.mutate("UPDATE meta SET clean=1");
  await writeFile(path.join(native.source.root, "code.txt"), "external");
  const id = randomUUID();
  const session = await f.engine.localOverlays.create(
    { id, source: native.source.root },
    (workspace) => f.store.create(workspace, "Review"),
  );
  await cp(native.control, path.join(f.engine.localOverlays.root, id), {
    recursive: true,
  });
  const url = `/api/sessions/${session.id}/local-review`;
  const payload = { path: "code.txt" };
  expect(
    (await f.app.inject({ method: "POST", url, payload })).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        payload,
        headers: { host: f.headers.host, cookie: f.headers.cookie },
      })
    ).statusCode,
  ).toBe(403);
  const result = await f.app.inject({
    method: "POST",
    url,
    payload,
    headers: f.headers,
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(result.json()).toMatchObject({
    path: "code.txt",
    publicationChecked: false,
    preview: { state: "conflict", reason: "TEXT_CONFLICT" },
  });
  expect(Buffer.from(result.json().ours.content, "base64").toString()).toBe(
    "private",
  );
  expect(result.body).not.toContain(native.source.root);
  expect(result.body).not.toContain(f.engine.localOverlays.root);
  expect(f.backend.mounted.size).toBe(0);
  const resolutionUrl = `/api/sessions/${session.id}/local-resolution`;
  const resolutionPayload = {
    id: randomUUID(),
    path: "code.txt",
    version: result.json().version,
  };
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: resolutionUrl,
        payload: resolutionPayload,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
  vi.spyOn(f.engine, "localOverlayCreation", "get").mockReturnValue({
    enabled: true,
  });
  const continued = await f.app.inject({
    method: "POST",
    url: resolutionUrl,
    payload: resolutionPayload,
    headers: f.headers,
  });
  expect(continued.statusCode).toBe(200);
  expect(continued.json().localOverlay.resolution.sessionId).toBe(session.id);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: resolutionUrl,
        payload: resolutionPayload,
        headers: f.headers,
      })
    ).json().id,
  ).toBe(continued.json().id);
  expect(await f.store.tasks(continued.json().id)).toHaveLength(0);
  for (const name of ["../escape", ".git/config", "missing.txt"]) {
    const rejected = await f.app.inject({
      method: "POST",
      url,
      payload: { path: name },
      headers: f.headers,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body).not.toContain("SQLite");
    expect(rejected.body).not.toContain(f.engine.localOverlays.root);
  }

  expect(
    (
      await f.app.inject({
        method: "POST",
        url,
        payload: { ...payload, control: native.control },
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  const lease = await f.engine.localOverlays.begin(
    session.workspace,
    session.id,
    randomUUID(),
    new AbortController().signal,
  );
  expect(
    (await f.app.inject({ method: "POST", url, payload, headers: f.headers }))
      .statusCode,
  ).toBe(409);
  await lease!.finish("cancelled", true);
  const ordinary = await f.store.create(f.source, "ordinary");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/api/sessions/${ordinary.id}/local-review`,
        payload,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
});

it("reviews and continues a bounded group without changing the single-file contract", async () => {
  const f = await fixture();
  const native = await nativeFixture();
  await native.change("first.txt", "base", "first private");
  await native.change("second.txt", null, "second private");
  native.mutate("UPDATE meta SET clean=1");
  const id = randomUUID();
  const parent = await f.engine.localOverlays.create(
    { id, source: native.source.root },
    (workspace) => f.store.create(workspace, "Batch review"),
  );
  await cp(native.control, path.join(f.engine.localOverlays.root, id), {
    recursive: true,
  });
  const url = `/api/sessions/${parent.id}/local-review`;
  const paths = ["first.txt", "second.txt"];
  const result = await f.app.inject({
    method: "POST",
    url,
    payload: { paths },
    headers: f.headers,
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(
    result.json().files.map((file: { path: string }) => file.path),
  ).toEqual(paths);
  for (const payload of [
    { paths: [] },
    { paths, path: "first.txt" },
    { paths: Array(101).fill("first.txt") },
  ]) {
    expect(
      (await f.app.inject({ method: "POST", url, payload, headers: f.headers }))
        .statusCode,
    ).toBe(400);
  }

  const resolutionUrl = `/api/sessions/${parent.id}/local-resolution`;
  const payload = { id: randomUUID(), paths, version: result.json().version };
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: resolutionUrl,
        payload,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
  vi.spyOn(f.engine, "localOverlayCreation", "get").mockReturnValue({
    enabled: true,
  });
  await writeFile(path.join(native.source.root, "second.txt"), "changed");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: resolutionUrl,
        payload,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(409);
  expect(f.backend.creates).toBe(1);
  const refreshed = await f.app.inject({
    method: "POST",
    url,
    payload: { paths },
    headers: f.headers,
  });
  payload.version = refreshed.json().version;
  const child = await f.app.inject({
    method: "POST",
    url: resolutionUrl,
    payload,
    headers: f.headers,
  });
  expect(child.statusCode).toBe(200);
  expect(child.json().localOverlay.resolution.paths).toEqual(paths);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: resolutionUrl,
        payload,
        headers: f.headers,
      })
    ).json().id,
  ).toBe(child.json().id);
  expect(await f.store.tasks(child.json().id)).toHaveLength(0);
  expect(f.backend.creates).toBe(2);
  expect(f.backend.mounted.size).toBe(0);
});

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
