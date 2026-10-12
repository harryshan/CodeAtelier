/**
 * 在临时目录和真实 SQLite Worker 上验证 tracing 后续生命周期，不连接模型或用户数据。
 * 1. 明确 callId 的 flow 不受辅助模型干扰，成功依赖与持久化分别连接。
 * 2. 队列取消归档、检查点清理和失败保留以实际文件结果断言；保留策略默认不删除。
 * 3. Worker 回执区分 roundtrip 与 SQL/JSON/事务；配置非法值不能静默扩大资源预算。
 * 4. 本地认证 API 下载运行中快照；模型夹具阻塞直至测试释放，确保观察真实运行态。
 */
import path from "node:path";
import { readFile, utimes } from "node:fs/promises";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { TraceArchive } from "../src/tracing/archive.js";
import { TraceTaskMonitor } from "../src/tracing/task-monitor.js";
import { traceConfiguration } from "../src/tracing/config.js";
import { Store } from "../src/sessions/store.js";
import { Config } from "../src/config/config.js";
import { createApp } from "../src/server/app.js";
import { Engine } from "../src/agent/engine.js";
import { temp } from "./fixtures/helpers.js";

const log = pino({ enabled: false });

it("connects the Engine recorder to Sandbox Broker preflight failures", async () => {
  const config = new Config(await temp());
  config.sandbox.enabled = false;
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const engine = new Engine(store, config, log);
  engine.traces.startTask("task", "session");
  try {
    await expect(
      engine.sandbox.launch({
        identity: {
          taskId: "task",
          sessionId: "session",
          executionInstanceId: "instance",
          kind: "agent-runtime",
        },
        nonce: "x".repeat(32),
        workspace: config.directory,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const events = engine.traces.exportTask("task")!.traceEvents;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "sandbox.availability",
          ph: "b",
          args: expect.objectContaining({ status: "error" }),
        }),
      ]),
    );
  } finally {
    engine.traces.discardTask("task");
    await engine.close();
    await store.closeAsync();
  }
});

it("binds model, dependent tool and persisted feedback by call ID", () => {
  const recorder = new TraceRecorder();
  recorder.startTask("task", "session");
  const span = (name: string, callId?: string) =>
    recorder.startSpan("task", {
      name,
      category: "test",
      track: name,
      attributes: { callId },
    })!;
  const model = span("model");
  recorder.relations.modelFinished(model, [
    { type: "function_call", call_id: "a" },
    { type: "function_call", call_id: "b" },
  ]);
  recorder.endSpan(model, "ok");
  recorder.endSpan(span("unrelated title"), "ok");
  recorder.relations.event("task", "tool_batch_planned", {
    nodes: [
      { nodeId: "A", callId: "a", dependsOn: [] },
      { nodeId: "B", callId: "b", dependsOn: ["A"] },
    ],
  });
  const first = span("tool-a", "a");
  recorder.relations.toolStarted(first);
  recorder.endSpan(first, "ok");
  const second = span("tool-b", "b");
  recorder.relations.toolStarted(second);
  recorder.endSpan(second, "ok");
  const persist = span("persist", "b");
  recorder.relations.persistStarted(persist);
  recorder.endSpan(persist, "ok");
  const next = span("next model");
  recorder.relations.modelStarted(next, [
    { type: "function_call_output", call_id: "b" },
  ]);
  const events = recorder.exportTask("task")!.traceEvents;
  const flows = events.filter((e) => e.ph === "n");
  expect(
    flows
      .filter((e) => e.flow_out && e.args.flowName === "llm_to_tool")
      .map((e) => e.args.spanId),
  ).toEqual([model.id, model.id]);
  for (const name of ["tool_dependency", "tool_to_result", "result_to_model"]) {
    expect(flows.filter((e) => e.args.flowName === name)).toHaveLength(2);
  }
});

it("archives queue cancellation, removes checkpoints and drains concurrent finalization", async () => {
  const root = await temp();
  const recorder = new TraceRecorder();
  const archive = new TraceArchive(root, log);
  const monitor = new TraceTaskMonitor(recorder, archive, log, 1);
  monitor.submitted("task", "session");
  monitor.waiting("task", "workspace");
  await monitor.finish("task", "session", "cancelled");
  await monitor.drain();
  const trace = JSON.parse((await archive.read("session", "task"))!);
  expect(trace.traceEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "task.queue",
        ph: "b",
        args: expect.objectContaining({
          reason: "workspace",
          status: "cancelled",
        }),
      }),
    ]),
  );
  expect(await archive.readCheckpoint("session", "task")).toBeUndefined();
  expect(recorder.hasTask("task")).toBe(false);
});

it("keeps a partial checkpoint if final archive fails", async () => {
  const root = await temp();
  const recorder = new TraceRecorder();
  const archive = new TraceArchive(root, log);
  vi.spyOn(archive, "write").mockResolvedValue(false);
  const monitor = new TraceTaskMonitor(recorder, archive, log, 1);
  monitor.submitted("task", "session");
  await monitor.finish("task", "session", "error");
  expect(
    JSON.parse((await archive.readCheckpoint("session", "task"))!).metadata
      .partial,
  ).toBe(true);
  expect(recorder.hasTask("task")).toBe(false);
});

it("retains archives by default and prunes expired JSON only when configured", async () => {
  const root = await temp();
  const archive = new TraceArchive(root, log);
  await archive.write("s", "old", {});
  const file = path.join(root, "traces", "s", "old.json");
  const past = new Date(Date.now() - 3 * 86400000);
  await utimes(file, past, past);
  await archive.write("s", "new", {});
  expect(await readFile(file, "utf8")).toBe("{}");
  await new TraceArchive(root, log, 1).write("s", "newest", {});
  expect(await archive.read("s", "old")).toBeUndefined();
  expect(await archive.read("s", "new")).toBe("{}");
});

it("records actual Worker transaction and JSON stages without content", async () => {
  const root = await temp();
  const store = new Store(path.join(root, "history.sqlite"));
  const recorder = new TraceRecorder();
  store.setTracer(recorder);
  try {
    const session = store.create(root);
    const task = store.createTask(session.id);
    recorder.startTask(task.id, session.id);
    await store.saveContextAsync(
      session.id,
      [{ role: "user", content: "PRIVATE_CONTEXT" }],
      task.id,
    );
    const events = recorder.exportTask(task.id)!.traceEvents;
    for (const name of [
      "store.queue",
      "store.write",
      "store.worker.connect",
      "store.worker.transaction.acquire",
      "store.worker.json.stringify",
      "store.worker.transaction.commit",
    ]) {
      expect(
        events.some(
          (e) => e.name === name && e.ph === "b" && e.args.status === "ok",
        ),
      ).toBe(true);
    }

    expect(JSON.stringify(events)).not.toContain("PRIVATE_CONTEXT");
  } finally {
    await store.closeAsync();
  }
});

it("rejects invalid tracing settings", () => {
  expect(traceConfiguration({}).retentionDays).toBe(0);
  for (const raw of ["-1", "NaN", "", "1.2"]) {
    expect(() =>
      traceConfiguration({ CODEATELIER_TRACE_MAX_RECORDS: raw }),
    ).toThrow();
  }
});

it("samples bounded resource counters and stops sampling after finalization", async () => {
  const root = await temp();
  vi.useFakeTimers();
  const recorder = new TraceRecorder();
  const archive = new TraceArchive(root, log);
  const monitor = new TraceTaskMonitor(recorder, archive, log);
  try {
    monitor.submitted("task", "session");
    monitor.waiting("task", "capacity");
    await vi.advanceTimersByTimeAsync(5000);
    const trace = recorder.exportTask("task")!;
    expect(trace.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "process.resources",
          ph: "C",
          args: expect.objectContaining({
            activeTraces: 1,
            queuedTraces: 1,
            rssBytes: expect.any(Number),
          }),
        }),
      ]),
    );
    await monitor.finish("task", "session", "ok");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    monitor.stop();
    vi.useRealTimers();
  }
});

it("requires authentication for partial live trace and distinguishes it from completed downloads", async () => {
  const config = new Config(await temp());
  config.sandbox.enabled = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createApp(config, log, () => ({
    async run() {
      await pending;

      return { output: [], text: "done" };
    },
  }));
  try {
    const session = await fixture.store.create(await temp(), "fixture");
    const task = await fixture.engine.start(session.id, "fixture");
    expect(
      (await fixture.app.inject({ url: `/api/tasks/${task.id}/trace/live` }))
        .statusCode,
    ).toBe(401);
    const bootstrap = await fixture.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    });
    const token = bootstrap.json().token;
    const headers = {
      host: "127.0.0.1",
      cookie: `ca_session=${token}`,
      "x-codeatelier-token": token,
    };
    const response = await fixture.app.inject({
      url: `/api/tasks/${task.id}/trace/live`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().metadata).toMatchObject({
      partial: true,
      taskId: task.id,
    });
    release();
    await fixture.engine.active?.done;
    expect(
      (
        await fixture.app.inject({
          url: `/api/tasks/${task.id}/trace`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    release();
    await fixture.app.close();
  }
});
