/**
 * 数据库阅读器 HTTP 回归，使用真实 Fastify/Store 与临时 SQLite，不连接模型或个人数据库。
 * 1. fixture 创建真实会话凭据；captured/legacy 任务通过 Store 写入合成事件和模型/工具记录。
 * 2. 验证目录不携带大载荷、详情只属于指定任务、在途结果保持未知，读取不改变任务状态。
 * 3. 检查缺失/跨会话 ID、cookie、Origin、no-store 与读取故障的安全错误，再验证重开服务后的记录。
 * 与 access-password.test.ts 的真实密码门禁互补；清理关闭 Worker 与数据库，不运行 Evaluation。
 */

import { expect, it, vi } from "vitest";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { createApp } from "../src/server/app.js";
import { replaySettings } from "../src/sessions/replay-case.js";
import { temp } from "./fixtures/helpers.js";

async function fixture(existingConfig?: Config) {
  const config = existingConfig ?? new Config(await temp());
  const server = await createApp(config, pino({ enabled: false }));
  const auth = await server.app.inject({
    url: "/api/bootstrap",
    headers: { host: "127.0.0.1" },
  });
  const headers = {
    host: "127.0.0.1",
    cookie: `ca_session=${auth.json().token}`,
  };

  return { ...server, config, headers };
}

it("reads captured and legacy tasks without mixing records or executing them", async () => {
  const { app, store, engine, config, headers } = await fixture();
  try {
    const session = store.create(await temp());
    const captured = store.createTask(session.id);
    const legacy = store.createTask(session.id);
    store.startReplayCapture(captured, {
      schemaVersion: 1,
      capturedAt: captured.createdAt,
      platform: "win32",
      settings: replaySettings(config.settings),
    });
    store.startReplayModelExchange(captured.id, {
      id: "model-1",
      purpose: "task",
      input: [],
      instructions: "synthetic-instructions",
      tools: [],
    });
    store.finishReplayModelExchange(captured.id, "model-1", {
      response: { output: [], text: "captured model reply" },
    });
    store.startReplayTool(captured.id, {
      callId: "pending-tool",
      nodeId: "pending-tool",
      batchId: "batch",
      name: "read_file",
      arguments: { path: "sample.txt" },
      dependsOn: [],
    });
    store.event(session.id, captured.id, "user", { text: "captured user" });
    store.event(session.id, legacy.id, "tool_start", {
      callId: "old-call",
      name: "read_file",
      args: { path: "old.txt" },
    });
    store.event(session.id, legacy.id, "tool_result", {
      callId: "old-call",
      result: { text: "legacy source" },
    });
    const before = store.replayCase(captured.id);
    const base = `/api/sessions/${session.id}/tasks`;
    const directory = await app.inject({ url: base, headers });
    const result = await app.inject({
      url: `${base}/${captured.id}/replay`,
      headers,
    });
    const old = await app.inject({
      url: `${base}/${legacy.id}/replay`,
      headers,
    });

    expect(directory.statusCode).toBe(200);
    expect(directory.json().map((task: { id: string }) => task.id)).toEqual([
      captured.id,
      legacy.id,
    ]);
    expect(directory.body).not.toContain("synthetic-instructions");
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toMatchObject({
      source: "captured",
      task: { id: captured.id, status: "queued" },
      capture: {
        modelExchanges: [{ response: { text: "captured model reply" } }],
      },
      tools: [{ callId: "pending-tool" }],
    });
    expect(result.json().tools[0]).not.toHaveProperty("result");
    expect(result.body).not.toContain("legacy source");
    expect(old.json()).toMatchObject({
      source: "legacy",
      tools: [{ result: { text: "legacy source" } }],
    });
    expect(old.body).not.toContain("captured model reply");
    expect(store.replayCase(captured.id)).toEqual(before);
    // hasActiveTasks 也统计我们手动写入的 queued 行；activeTasks 才是实际运行中的引擎任务。
    expect(engine.activeTasks).toEqual([]);
    expect(store.task(legacy.id)?.status).toBe("queued");
  } finally {
    await app.close();
  }
});

it("rejects unauthorized and cross-session reads and safely reports storage failures", async () => {
  const { app, store, headers } = await fixture();
  try {
    const one = store.create(await temp());
    const two = store.create(await temp());
    const task = store.createTask(two.id);
    const directory = `/api/sessions/${two.id}/tasks`;
    const detail = `${directory}/${task.id}/replay`;
    for (const url of [directory, detail]) {
      expect(
        (await app.inject({ url, headers: { host: "127.0.0.1" } })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            url,
            headers: { ...headers, origin: "https://evil.invalid" },
          })
        ).statusCode,
      ).toBe(403);
    }

    for (const url of [
      "/api/sessions/missing/tasks",
      `${directory}/missing/replay`,
      `/api/sessions/${one.id}/tasks/${task.id}/replay`,
    ]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
    }

    expect(
      (
        await app.inject({ url: `/api/sessions/${one.id}/tasks`, headers })
      ).json(),
    ).toEqual([]);
    const broken = vi.spyOn(store, "replayCase").mockImplementation(() => {
      throw new Error("sensitive damaged payload");
    });
    try {
      const failed = await app.inject({ url: detail, headers });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("sensitive damaged payload");
    } finally {
      broken.mockRestore();
    }

    expect((await app.inject({ url: detail, headers })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it("can read persisted records after reopening the service", async () => {
  const original = await fixture();
  const session = original.store.create(await temp());
  const task = original.store.createTask(session.id);
  original.store.event(session.id, task.id, "user", {
    text: "persisted message",
  });
  original.store.status(task.id, "completed");
  await original.app.close();
  const reopened = await fixture(original.config);
  try {
    const result = await reopened.app.inject({
      url: `/api/sessions/${session.id}/tasks/${task.id}/replay`,
      headers: reopened.headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      task: { id: task.id, status: "completed" },
      events: [{ data: { text: "persisted message" } }],
    });
  } finally {
    await reopened.app.close();
  }
});
