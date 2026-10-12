/**
 * 验证任务 tracing 在异步交叉、凭据输入和异常收尾时仍能生成可信的本地诊断记录。
 * 1. Recorder 用固定时间构造交叉、零时长与跨进程 span，检查异步 ID 配对和 flow 的实际端点。
 * 2. 凭据用例只使用假值，覆盖结构化字段、命令参数与普通计数，确保导出可读且不泄露凭据。
 * 3. Engine 用临时 Store 和确定性模型注入终态写库、导出与归档故障，检查任务结果和内存释放。
 * 不连接模型服务或 Sandbox 安装，不重放工具；临时文件由测试资源夹具清理。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { Config } from "../src/config/config.js";
import { createApp } from "../src/server/app.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { temp } from "./fixtures/helpers.js";

it("pairs crossing asynchronous lifetimes independently of their logical track", () => {
  const recorder = new TraceRecorder();
  const task = recorder.startTask("crossing", "session");
  const origin = task.startedAtUs + 10;

  for (const track of ["Main thread", "Store queue", "Broker host commands"]) {
    const first = recorder.startSpan(task.taskId, {
      name: "operation",
      category: "test",
      track,
      startedAtUs: origin,
      attributes: { callId: `${track}-first` },
    });
    const second = recorder.startSpan(task.taskId, {
      name: "operation",
      category: "test",
      track,
      startedAtUs: origin + 10,
      attributes: { callId: `${track}-second` },
    });
    recorder.endSpan(first, "ok", {}, origin + 20);
    recorder.endSpan(second, "error", {}, origin + 40);
  }

  const events = recorder.exportTask(task.taskId)!.traceEvents;
  const starts = events.filter(
    (event) => event.name === "operation" && event.ph === "b",
  );
  expect(starts).toHaveLength(6);
  expect(new Set(starts.map((event) => event.id2.local)).size).toBe(6);
  for (const start of starts) {
    const end = events.find(
      (event) => event.ph === "e" && event.id2.local === start.id2.local,
    );
    expect(end).toBeDefined();
    expect(end.ts - start.ts).toBe(
      start.args.callId.endsWith("first") ? 20 : 30,
    );
    expect(start.args.logicalTrack).toBeDefined();
    expect(start.args.spanId).toBeDefined();
  }
});

it("exports zero-duration lifetimes with begin before end and closes unfinished spans", () => {
  const recorder = new TraceRecorder();
  const task = recorder.startTask("zero", "session");
  const zero = recorder.startSpan(task.taskId, {
    name: "zero",
    category: "test",
    track: "Main thread",
    startedAtUs: task.startedAtUs,
  });
  recorder.endSpan(zero, "ok", {}, task.startedAtUs);
  recorder.startSpan(task.taskId, {
    name: "unfinished",
    category: "test",
    track: "Agent Runtime",
    processId: 12345,
  });
  recorder.finishTask(task.taskId, "cancelled");

  const events = recorder.exportTask(task.taskId)!.traceEvents;
  expect(
    events.filter((event) => event.name === "zero").map((event) => event.ph),
  ).toEqual(["b", "e"]);
  const begin = events.find(
    (event) => event.name === "unfinished" && event.ph === "b",
  );
  const end = events.find(
    (event) => event.name === "unfinished" && event.ph === "e",
  );
  expect(begin.args.status).toBe("cancelled");
  expect(end).toMatchObject({ pid: 12345, id2: begin.id2 });
  expect(end.ts).toBeGreaterThanOrEqual(begin.ts);
});

it("binds a flow to the source and destination async lifetimes", () => {
  const recorder = new TraceRecorder();
  const task = recorder.startTask("flow", "session");
  const origin = task.startedAtUs + 10;
  const source = recorder.startSpan(task.taskId, {
    name: "llm.request",
    category: "llm",
    track: "Main thread",
    startedAtUs: origin,
  });
  recorder.endSpan(source, "ok", {}, origin + 10);
  const target = recorder.startSpan(task.taskId, {
    name: "tool.read_file",
    category: "tool",
    track: "Agent Runtime tool 1",
    processId: 12345,
    startedAtUs: origin + 10,
  });
  recorder.endSpan(target, "ok", {}, origin + 20);
  recorder.link(source, target, "llm_to_tool");

  const events = recorder.exportTask(task.taskId)!.traceEvents;
  const sourceBegin = events.find(
    (event) => event.name === "llm.request" && event.ph === "b",
  );
  const targetBegin = events.find(
    (event) => event.name === "tool.read_file" && event.ph === "b",
  );
  const output = events.find((event) => event.flow_out);
  const input = events.find((event) => event.flow_in);
  expect(output).toMatchObject({
    ph: "n",
    name: sourceBegin.name,
    cat: sourceBegin.cat,
    id2: sourceBegin.id2,
    ts: origin + 10,
    args: { flowName: "llm_to_tool", spanId: source!.id },
  });
  expect(input).toMatchObject({
    ph: "n",
    name: targetBegin.name,
    cat: targetBegin.cat,
    id2: targetBegin.id2,
    pid: 12345,
    ts: origin + 10,
    args: { flowName: "llm_to_tool", spanId: target!.id },
  });
  expect(input.bind_id).toBe(output.bind_id);
  expect(events.indexOf(output)).toBeLessThan(
    events.findIndex(
      (event) => event.name === "llm.request" && event.ph === "e",
    ),
  );
  expect(events.indexOf(input)).toBeGreaterThan(events.indexOf(targetBegin));
});

it("redacts credential aliases and command values without removing normal diagnostic fields", () => {
  const recorder = new TraceRecorder();
  recorder.startTask("secrets", "session");
  const span = recorder.startSpan("secrets", {
    name: "tool.run_command",
    category: "tool",
    track: "Tool worker 1",
    attributes: {
      inputTokens: 42,
      parameters: {
        access_token: "FAKE_ACCESS",
        refreshToken: "FAKE_REFRESH",
        client_secret: "FAKE_CLIENT",
        headers: { "X-Api-Key": "FAKE_HEADER", "Set-Cookie": "FAKE_COOKIE" },
        password: 123456,
        nested: [{ private_key: "FAKE_PRIVATE" }],
        command:
          "curl --password 'FAKE CLI VALUE' --access-token=FAKE_CLI_TOKEN -H 'Authorization: Basic FAKE_BASIC'",
        source: 'const accessToken = "FAKE_SOURCE";',
        path: "src/main.ts",
        tokenCount: 12,
      },
    },
  });
  recorder.endSpan(span, "ok");

  const trace = recorder.exportTask("secrets")!;
  const text = JSON.stringify(trace);
  expect(text).not.toContain("FAKE_");
  expect(text).not.toContain("123456");
  const event = trace.traceEvents.find(
    (entry) => entry.name === "tool.run_command" && entry.args,
  );
  expect(event.args).toMatchObject({
    inputTokens: 42,
    parameters: { path: "src/main.ts", tokenCount: 12 },
  });
});

it("archives a failed trace and releases it when terminal task persistence rejects", async () => {
  const config = new Config(await temp());
  config.sandbox.enabled = false;
  const fixture = await createApp(config, pino({ enabled: false }), () => ({
    async run() {
      return { output: [], text: "done" };
    },
  }));
  const saveStatus = fixture.store.statusAsync.bind(fixture.store);
  vi.spyOn(fixture.store, "statusAsync").mockImplementation(
    async (id, status, error) => {
      if (status === "completed") {
        throw new Error("injected terminal persistence failure");
      }

      return saveStatus(id, status, error);
    },
  );

  try {
    const session = await fixture.store.create(await temp(), "trace failure");
    const task = await fixture.engine.start(session.id, "fixture");
    await fixture.engine.active?.done;

    const trace = JSON.parse(
      await readFile(
        path.join(config.directory, "traces", session.id, task.id + ".json"),
        "utf8",
      ),
    );
    expect(
      trace.traceEvents.find(
        (event: any) => event.name === "task.run" && event.args,
      ).args.status,
    ).toBe("error");
    expect(fixture.engine.traces.exportTask(task.id)).toBeUndefined();
    expect((await fixture.store.task(task.id))?.status).toBe("failed");
    expect(
      (await fixture.store.taskEvents(task.id)).filter(
        (event) => event.type === "tool_start",
      ),
    ).toHaveLength(0);
  } finally {
    await fixture.app.close();
  }
});

it.each(["export", "archive"] as const)(
  "releases trace memory without failing a completed task after %s failure",
  async (stage) => {
    const config = new Config(await temp());
    config.sandbox.enabled = false;
    const fixture = await createApp(config, pino({ enabled: false }), () => ({
      async run() {
        return { output: [], text: "done" };
      },
    }));
    const failure = () => {
      throw new Error("injected trace failure");
    };

    const injection =
      stage === "export"
        ? vi
            .spyOn(fixture.engine.traces, "exportTask")
            .mockImplementation(failure)
        : vi
            .spyOn(fixture.engine.traceArchive, "write")
            .mockImplementation(failure);

    try {
      const session = await fixture.store.create(await temp(), "trace failure");
      const task = await fixture.engine.start(session.id, "fixture");
      await fixture.engine.active?.done;
      injection.mockRestore();

      expect(fixture.engine.traces.exportTask(task.id)).toBeUndefined();
      expect((await fixture.store.task(task.id))?.status).toBe("completed");
      expect(await fixture.store.taskEvents(task.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "task_end",
            data: { status: "completed" },
          }),
        ]),
      );
    } finally {
      injection.mockRestore();
      await fixture.app.close();
    }
  },
);
