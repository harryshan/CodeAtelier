/**
 * 隔离 Local 默认关闭的产品回归，不替换生产代码开关。
 * 1. 使用真实 HTTP/Engine/Store 与挂载替身建立旧会话，再检查 bootstrap、创建及所有操作拒绝。
 * 2. 开启 Sandbox、注入后端或直接调用 Engine 均不能绕过；拒绝前不挂载、不新增任务或发布。
 * 3. 普通会话仍能执行；旧视图历史、私有内容、清单及取消/关闭路径保留，损坏清单也不能转宿主。
 * 本套件不运行原生文件系统或 OS Sandbox，不构成安装态验收；开启后的协议由其它显式 opt-in 套件覆盖。
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import {
  LOCAL_OVERLAY_ENABLED,
  LOCAL_OVERLAY_DISABLED_REASON,
} from "../src/local-overlays/readiness.js";
import { createTestApp } from "./fixtures/managed-runtime.js";
import { FakeLocalOverlayBackend } from "./fixtures/local-overlay-backend.js";
import { temp } from "./fixtures/helpers.js";

it("closes every product entry without mounting or losing private history", async () => {
  expect(LOCAL_OVERLAY_ENABLED).toBe(false);
  const config = new Config(await temp());
  const backend = new FakeLocalOverlayBackend(await temp());
  const server = await createTestApp(
    config,
    pino({ enabled: false }),
    () => ({
      async run() {
        return { text: "ordinary local works", output: [] };
      },
    }),
    undefined,
    undefined,
    false,
    backend,
  );
  const { app, engine, store } = server;
  const source = await temp();
  const id = randomUUID();
  // 直接调用底层服务仅用于制作关闭前已存在的数据，不属于公开产品入口。
  const session = await engine.localOverlays.create(
    { id, source },
    (workspace) => store.create(workspace, "Retained overlay"),
  );
  const privateFile = path.join(session.workspace, "private.txt");
  await writeFile(privateFile, "retain my edits");
  const manifest = path.join(engine.localOverlays.root, `${id}.json`);
  const originalManifest = await readFile(manifest);
  const { task } = await store.startTaskAsync(
    session.id,
    "previous work",
    false,
  );
  await store.statusAsync(task.id, "interrupted");
  config.sandbox.enabled = true;

  const bootstrap = (await app.inject({ url: "/api/bootstrap" })).json();
  expect(bootstrap.localOverlayCreation).toEqual({
    featureEnabled: false,
    enabled: false,
    reason: LOCAL_OVERLAY_DISABLED_REASON,
  });
  const headers = {
    host: "127.0.0.1",
    cookie: `ca_session=${bootstrap.token}`,
    "x-codeatelier-token": bootstrap.token,
  };
  const open = vi.spyOn(backend, "open");
  const prefix = `/api/sessions/${session.id}`;
  const requests: [string, object][] = [
    [
      "/api/sessions",
      { workspace: source, localOverlay: { id: randomUUID() } },
    ],
    [`${prefix}/tasks`, { prompt: "continue" }],
    [`/api/tasks/${task.id}/resume`, { instruction: "continue" }],
    [`${prefix}/local-refresh`, {}],
    [`${prefix}/local-review`, { paths: ["private.txt"] }],
    [
      `${prefix}/local-review`,
      { paths: ["private.txt"], state: "interrupted" },
    ],
    [
      `${prefix}/local-resolution`,
      { id: randomUUID(), version: "a".repeat(64), path: "private.txt" },
    ],
    [`${prefix}/local-publication-review`, {}],
    [`${prefix}/local-publication-accept`, { token: "a".repeat(64) }],
    [`${prefix}/local-publication-release-complete`, {}],
  ];
  for (const [url, payload] of requests) {
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload,
    });
    expect(response.statusCode, url).toBe(409);
    expect(response.json().error, url).toBe(LOCAL_OVERLAY_DISABLED_REASON);
  }

  await expect(engine.startAsync(session.id, "bypass HTTP")).rejects.toThrow(
    LOCAL_OVERLAY_DISABLED_REASON,
  );
  await expect(engine.resumeAsync(task.id)).rejects.toThrow(
    LOCAL_OVERLAY_DISABLED_REASON,
  );
  await expect(
    engine.selectLocalPublication(task.id, {
      paths: ["private.txt"],
      commands: [],
    }),
  ).rejects.toThrow(LOCAL_OVERLAY_DISABLED_REASON);
  expect(await store.tasks(session.id)).toHaveLength(1);
  expect((await store.task(task.id))?.status).toBe("interrupted");
  expect(await readFile(manifest)).toEqual(originalManifest);
  expect(await readFile(privateFile, "utf8")).toBe("retain my edits");
  expect(backend.publications).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();

  for (const suffix of ["", "?before=1"]) {
    const response = await app.inject({ url: prefix + suffix, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().session.localOverlay.state).toBe("ready");
  }

  const list = (await app.inject({ url: "/api/sessions", headers })).json();
  expect(list.some((entry: { id: string }) => entry.id === session.id)).toBe(
    true,
  );
  await writeFile(manifest, "broken manifest");
  await expect(
    engine.startAsync(session.id, "bad manifest bypass"),
  ).rejects.toThrow(LOCAL_OVERLAY_DISABLED_REASON);
  const history = await app.inject({ url: prefix, headers });
  expect(history.json().session.localOverlay.state).toBe("unavailable");

  config.sandbox.enabled = false;
  const ordinary = await store.create(source, "Ordinary Local");
  const ordinaryTask = await engine.startAsync(ordinary.id, "ordinary task");
  await engine.active?.done;
  expect((await store.task(ordinaryTask.id))?.status).toBe("completed");
  expect(open).not.toHaveBeenCalled();
  const cancelled = await app.inject({
    method: "POST",
    url: `/api/tasks/${task.id}/cancel`,
    headers,
    payload: {},
  });
  expect(cancelled.statusCode).toBe(200);
  await server.shutdown();
  expect(await readFile(privateFile, "utf8")).toBe("retain my edits");
});
