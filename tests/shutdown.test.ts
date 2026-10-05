/**
 * 检查关闭服务时的鉴权、任务保存、连接清理和进程退出。
 * 分别使用注入请求、真实 HTTP/SSE 连接和生产入口子进程验证。
 *
 * 1. 拒绝没有凭据、凭据伪造或缺少 confirm 的关闭请求。
 * 2. 按任务审批事件和持久化命令输出确认就绪，再连接 SSE；关闭后检查流结束、端口释放及 SQLite 中的中断记录。
 * 3. 启动 launcher.ts 父进程，确认它能在认证后的重载请求后替换后端子进程，并在关闭后正常退出。
 *
 * 收到关闭响应还不够，必须确认资源确实释放；测试负责清理自己启动的进程。
 */

import { it, expect } from "vitest";
import pino from "pino";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { temp, waitForApproval } from "./fixtures/helpers.js";

it("rejects unauthenticated, forged and unconfirmed shutdown requests", async () => {
  const { app } = await createApp(
    new Config(await temp()),
    pino({ enabled: false }),
  );

  try {
    const auth = await app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    });
    const token = auth.json().token;

    for (const [headers, payload, status] of [
      [{ host: "127.0.0.1" }, { confirm: true }, 401],
      [
        {
          host: "127.0.0.1",
          cookie: "ca_session=" + token,
          "x-codeatelier-token": "bad",
        },
        { confirm: true },
        403,
      ],
      [
        {
          host: "127.0.0.1",
          cookie: "ca_session=" + token,
          "x-codeatelier-token": token,
        },
        { confirm: false },
        400,
      ],
    ] as const) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/server/shutdown",
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(status);
    }

    const unsupportedReload = await app.inject({
      method: "POST",
      url: "/api/server/reload",
      headers: {
        host: "127.0.0.1",
        cookie: "ca_session=" + token,
        "x-codeatelier-token": token,
      },
      payload: { confirm: true },
    });

    expect(unsupportedReload.statusCode).toBe(409);
    expect(JSON.parse(unsupportedReload.body)).toEqual({
      error: "当前启动方式不支持服务重载，请在终端重新启动服务。",
    });
    expect(
      (
        await app.inject({
          url: "/api/bootstrap",
          headers: { host: "127.0.0.1" },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});

it("shutdown acknowledges a running task, closes SSE, releases the port and persists interruption", async () => {
  const config = new Config(await temp());
  let stopped = 0;
  const fixture = await createApp(
    config,
    pino({ enabled: false }),
    () => ({
      async run() {
        return {
          output: [
            {
              type: "function_call",
              call_id: "command",
              name: "run_command",
              arguments: JSON.stringify({
                command:
                  "node -e \"console.log('ready');setInterval(()=>{},1000)\"",
              }),
            },
          ],
          text: "",
        };
      },
    }),
    () => {
      stopped++;
    },
  );
  const url = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const auth = await (await fetch(url + "/api/bootstrap")).json();
    const headers = {
      cookie: "ca_session=" + auth.token,
      "x-codeatelier-token": auth.token,
      "content-type": "application/json",
    };
    const session = fixture.store.create(await temp(), "shutdown");
    const task = fixture.engine.start(session.id, "run");

    await waitForApproval(fixture.engine, task.id);
    expect(fixture.engine.approvals.list()).toHaveLength(1);
    fixture.engine.approvals.decide(
      fixture.engine.approvals.list()[0].id,
      "once",
    );

    // 首次命令输出要等待冷启动的 Store Worker 提交，不能用默认的短轮询期限判断子进程未启动。
    await expect
      .poll(
        () =>
          fixture.store
            .events(session.id)
            .some(
              (e) =>
                e.type === "command_output" && e.data.text.includes("ready"),
            ),
        { timeout: 10_000 },
      )
      .toBe(true);
    const stream = await fetch(url + `/api/sessions/${session.id}/events`, {
      headers,
    });

    reader = stream.body!.getReader();
    await reader.read();
    const response = await fetch(url + "/api/server/shutdown", {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect.poll(() => stopped).toBe(1);
    let chunk;

    do {
      chunk = await reader.read();
    } while (!chunk.done);

    await expect(fetch(url + "/api/bootstrap")).rejects.toThrow();
    const saved = new Store(path.join(config.directory, "history.sqlite"));

    try {
      expect(saved.task(task.id)?.status).toBe("interrupted");
      expect(
        saved.events(session.id).some((e) => e.type === "command_output"),
      ).toBe(true);
    } finally {
      saved.close();
    }

    await fixture.shutdown();

    expect(stopped).toBe(1);
  } finally {
    await reader?.cancel();
    await fixture.shutdown();
  }
});

async function availablePort() {
  const server = createServer();

  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  server.close();
  await once(server, "close");

  return port;
}

function listeningUrls(output: string) {
  return [
    ...output.matchAll(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/g),
  ].map((match) => match[1]);
}

it("the production launcher replaces the backend after authenticated reload and exits after shutdown", async () => {
  const directory = await temp();
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.resolve("src/server/launcher.ts")],
    {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        CODEATELIER_DATA_DIR: directory,
        CODEATELIER_PORT: String(port),
        CODEATELIER_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exit = once(child, "exit");
  let output = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.resume();
  try {
    await expect
      .poll(() => listeningUrls(output).length, { timeout: 10000 })
      .toBe(1);
    const url = listeningUrls(output)[0];
    const auth = await (await fetch(url + "/api/bootstrap")).json();
    const headers = {
      cookie: "ca_session=" + auth.token,
      "x-codeatelier-token": auth.token,
      "content-type": "application/json",
    };
    const reload = await fetch(url + "/api/server/reload", {
      method: "POST",
      headers,
      body: '{"confirm":true}',
    });

    expect(reload.status).toBe(200);
    expect(await reload.json()).toEqual({ ok: true });
    await expect
      .poll(() => listeningUrls(output).length, { timeout: 10000 })
      .toBe(2);
    expect(listeningUrls(output)[1]).toBe(url);

    const replacement = await (await fetch(url + "/api/bootstrap")).json();
    const shutdown = await fetch(url + "/api/server/shutdown", {
      method: "POST",
      headers: {
        cookie: "ca_session=" + replacement.token,
        "x-codeatelier-token": replacement.token,
        "content-type": "application/json",
      },
      body: '{"confirm":true}',
    });

    expect(shutdown.status).toBe(200);
    expect(await shutdown.json()).toEqual({ ok: true });
    await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
    await exit;
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exit;
    }
  }
});
