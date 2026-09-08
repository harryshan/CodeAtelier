import { it, expect, afterEach } from "vitest";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import pino from "pino";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { Engine } from "../src/agent/engine.js";
import { ResponsesProvider } from "../src/providers/responses-provider.js";
import { type ModelProvider } from "../src/providers/model-provider.js";
import { ModelError, modelError } from "../src/providers/model-error.js";
import { retryModel } from "../src/providers/retry.js";

const dirs: string[] = [];

async function temp() {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "ca-recovery-")),
  );

  dirs.push(dir);

  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const done = {
  output: [
    {
      role: "assistant",
      type: "message",
      content: [{ type: "output_text", text: "done" }],
    },
  ],
  text: "done",
};

it("retries transient failures with a finite budget and respects permanent HTTP errors", async () => {
  let calls = 0;
  const notices: number[] = [];

  await expect(
    retryModel(
      async () => {
        if (++calls < 3) {
          throw new ModelError("offline", true, "connection");
        }

        return "ok";
      },
      new AbortController().signal,
      (_e, a) => notices.push(a),
      { retries: 2, baseDelayMs: 1 },
    ),
  ).resolves.toBe("ok");
  expect(notices).toEqual([1, 2]);
  calls = 0;

  await expect(
    retryModel(
      async () => {
        calls++;
        throw new ModelError("offline", true, "connection");
      },
      new AbortController().signal,
      () => {},
      { retries: 2, baseDelayMs: 1 },
    ),
  ).rejects.toThrow("offline");
  expect(calls).toBe(3);
  for (const status of [400, 401, 403, 404, 422]) {
    expect(modelError({ status }).retryable).toBe(false);
  }

  for (const status of [408, 409, 429, 500, 503]) {
    expect(modelError({ status }).retryable).toBe(true);
  }

  expect(
    modelError({ status: 429, headers: new Headers({ "retry-after": "2" }) })
      .retryAfterMs,
  ).toBe(2000);
});

it("cancels backoff without issuing another model request", async () => {
  const abort = new AbortController();
  let calls = 0;

  await expect(
    retryModel(
      async () => {
        calls++;
        throw new ModelError("offline", true, "connection");
      },
      abort.signal,
      () => abort.abort(),
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("recovers a disconnected stream without executing partial tool calls", async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events =
      ++calls === 1
        ? [
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "function_call",
                call_id: "partial",
                name: "write_file",
                arguments: "{}",
              },
            },
          ]
        : [{ type: "response.completed", response: { output: done.output } }];

    for (const event of events) {
      res.write("data: " + JSON.stringify(event) + "\n\n");
    }

    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const config = new Config(await temp());
    const provider = new ResponsesProvider(
      {
        ...config.settings,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      },
      "key",
    );
    const signal = new AbortController().signal;
    const result = await retryModel(
      () => provider.run([], "", [], signal, () => {}),
      signal,
      () => {},
      { retries: 2, baseDelayMs: 1 },
    );

    expect(result).toEqual(done);
    expect(calls).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("distinguishes idle timeout, total timeout and explicit cancellation", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const config = new Config(await temp());
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

    for (const [idleTimeoutMs, requestTimeoutMs, code] of [
      [30, 1000, "idle_timeout"],
      [1000, 30, "request_timeout"],
    ] as const) {
      await expect(
        new ResponsesProvider(
          { ...config.settings, baseUrl, idleTimeoutMs, requestTimeoutMs },
          "key",
        ).run([], "", [], new AbortController().signal, () => {}),
      ).rejects.toMatchObject({ code, retryable: true });
    }

    const abort = new AbortController();
    const pending = new ResponsesProvider(
      { ...config.settings, baseUrl },
      "key",
    ).run([], "", [], abort.signal, () => {});

    abort.abort(new Error("user cancelled"));

    await expect(pending).rejects.toThrow("user cancelled");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("resumes after completed file edits without replaying them and keeps original intent", async () => {
  const root = await temp();
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "history.sqlite"));
  let phase = 0;
  let inputs: any[] = [];
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input) {
      inputs = structuredClone(input);
      if (phase++ === 0) {
        return {
          output: [
            {
              type: "function_call",
              name: "write_file",
              call_id: "edit",
              arguments: JSON.stringify({
                path: "result.txt",
                content: "once",
              }),
            },
          ],
          text: "",
        };
      }

      if (phase === 2) {
        throw new ModelError("fix key", false, "auth");
      }

      return done;
    },
  }));

  try {
    const session = store.create(root, "test");
    const original = engine.start(session.id, "write once");

    await engine.active?.done;

    expect(store.task(original.id)?.status).toBe("failed");
    const resumed = engine.resume(original.id, "continue verification");

    expect(() => engine.resume(original.id)).toThrow("已有任务");
    await engine.active?.done;

    expect(store.task(resumed.id)?.status).toBe("completed");
    expect(await readFile(path.join(root, "result.txt"), "utf8")).toBe("once");
    expect(
      inputs.filter(
        (i) => i.type === "function_call_output" && i.call_id === "edit",
      ),
    ).toHaveLength(1);
    expect(
      store.events(session.id).filter((e) => e.type === "tool_start"),
    ).toHaveLength(1);
    expect(() => engine.resume(original.id)).toThrow("最后一个任务");
    expect(
      store.events(session.id).find((e) => e.type === "recovery")?.data
        .sourceTaskId,
    ).toBe(original.id);
  } finally {
    await engine.close();
    store.close();
  }
});

it("restores recorded tool results and marks unknown calls after a database restart", async () => {
  const config = new Config(await temp());
  const file = path.join(config.directory, "history.sqlite");
  let store = new Store(file);
  const session = store.create(await temp(), "crash");
  const task = store.createTask(session.id);

  store.event(session.id, task.id, "user", { text: "continue work" });
  store.saveContext(session.id, [
    { role: "user", content: "continue work" },
    ...["known", "unknown"].map((call_id) => ({
      type: "function_call",
      call_id,
      name: "run_command",
      arguments: "{}",
    })),
  ]);
  store.event(session.id, task.id, "tool_result", {
    callId: "known",
    result: { exitCode: 0, output: "already done" },
  });
  store.close();
  store = new Store(file);
  let inputs: any[] = [];
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input) {
      inputs = input;

      return done;
    },
  }));

  try {
    expect(store.task(task.id)?.status).toBe("interrupted");
    engine.resume(task.id);
    await engine.active?.done;

    expect(
      inputs.find(
        (i) => i.call_id === "known" && i.type === "function_call_output",
      ).output,
    ).toContain("already done");
    expect(
      inputs.find(
        (i) => i.call_id === "unknown" && i.type === "function_call_output",
      ).output,
    ).toContain("不可自动重放");
    expect(
      store.events(session.id).filter((e) => e.type === "tool_start"),
    ).toHaveLength(0);
  } finally {
    await engine.close();
    store.close();
  }
});

it("shutdown and approval cancellation remain recoverable and release the task lock", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const provider: ModelProvider = {
    async run() {
      return {
        output: [
          {
            type: "function_call",
            name: "run_command",
            call_id: "pending",
            arguments: JSON.stringify({
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
              cwd: ".",
            }),
          },
        ],
        text: "",
      };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
  );

  try {
    const session = store.create(await temp(), "approval");
    const first = engine.start(session.id, "verify");

    await expect.poll(() => engine.approvals.list().length).toBe(1);
    await engine.close();

    expect(store.task(first.id)?.status).toBe("interrupted");
    const next = engine.resume(first.id);

    await expect.poll(() => engine.approvals.list().length).toBe(1);
    engine.cancel(next.id);
    await engine.active?.done;

    expect(store.task(next.id)?.status).toBe("cancelled");
    expect(engine.approvals.list()).toHaveLength(0);
    expect(engine.active).toBeUndefined();
  } finally {
    await engine.close();
    store.close();
  }
});

it("automatic model retry after a tool result does not repeat the completed edit", async () => {
  const config = new Config(await temp());
  const root = await temp();
  const store = new Store(path.join(config.directory, "history.sqlite"));
  let calls = 0;
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input) {
      calls++;
      if (calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              name: "write_file",
              call_id: "once",
              arguments: JSON.stringify({ path: "once.txt", content: "saved" }),
            },
          ],
          text: "",
        };
      }

      expect(
        input.filter(
          (i) => i.type === "function_call_output" && i.call_id === "once",
        ),
      ).toHaveLength(1);
      if (calls === 2) {
        throw new ModelError("temporary", true, "connection");
      }

      return done;
    },
  }));

  try {
    const session = store.create(root, "retry");
    const task = engine.start(session.id, "write");

    await engine.active?.done;

    expect(store.task(task.id)?.status).toBe("completed");
    expect(calls).toBe(3);
    expect(
      store.events(session.id).filter((e) => e.type === "tool_start"),
    ).toHaveLength(1);
    expect(
      store.events(session.id).filter((e) => e.type === "notice"),
    ).toHaveLength(1);
    expect(await readFile(path.join(root, "once.txt"), "utf8")).toBe("saved");
  } finally {
    await engine.close();
    store.close();
  }
});
