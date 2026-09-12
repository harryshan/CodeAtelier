/**
 * 文件作用：验证关闭服务的鉴权、连接释放、状态保存和进程退出。
 * 代码结构：用例从未授权关闭开始，再验证运行中任务和 SSE 的清理，最后启动生产入口检查实际退出。
 */

import { it, expect } from "vitest";
import pino from "pino";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

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
                command: process.execPath,
                args: ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
                cwd: ".",
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

    await expect.poll(() => fixture.engine.approvals.list().length).toBe(1);
    fixture.engine.approvals.decide(
      fixture.engine.approvals.list()[0].id,
      "once",
    );

    await expect
      .poll(() =>
        fixture.store
          .events(session.id)
          .some(
            (e) => e.type === "command_output" && e.data.text.includes("ready"),
          ),
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

it("the production entry point exits successfully after authenticated shutdown", async () => {
  const directory = await temp();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.resolve("src/server/main.ts")],
    {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        CODEATELIER_DATA_DIR: directory,
        CODEATELIER_PORT: "0",
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
      .poll(
        () =>
          output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1],
        { timeout: 10000 },
      )
      .toBeTruthy();
    const url = output.match(
      /Server listening at (http:\/\/127\.0\.0\.1:\d+)/,
    )![1];
    const auth = await (await fetch(url + "/api/bootstrap")).json();
    const response = await fetch(url + "/api/server/shutdown", {
      method: "POST",
      headers: {
        cookie: "ca_session=" + auth.token,
        "x-codeatelier-token": auth.token,
        "content-type": "application/json",
      },
      body: '{"confirm":true}',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
    await exit;
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exit;
    }
  }
});
