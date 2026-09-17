/**
 * 验证 Perfetto tracing 的可导出时间线、敏感原文边界、会话/任务级持久化和真实 HTTP 下载接口。
 * 第一组直接驱动 TraceRecorder，检查主线程 begin/end slice、instant、flow 与递归凭据脱敏的 tool 参数被转换为 Chrome Trace Event JSON；
 * 第二组通过生产 createApp、Engine 和模拟模型完成并发工具任务，确认 context.prepare 与 context.request 的内部预算计量和机械整理阶段、响应/计划/持久化阶段、四条可复用工具轨道及任务根 span 写入数据目录后即释放内存，并可经本机受保护 API 和真实文件清单下载。
 *
 * 测试不连接真实模型服务，也不写入用户工作区；它只检查导出的可观察结构和临时数据目录，不依赖具体微秒耗时。
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import pino from "pino";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { Config } from "../src/config/config.js";
import { createApp } from "../src/server/app.js";
import { temp } from "./fixtures/helpers.js";

it("exports spans, instants and cross-track flows as Perfetto Trace Event JSON", () => {
  const recorder = new TraceRecorder();
  const task = recorder.startTask("task-1", "session-1");
  const responseProcessing = recorder.startSpan("task-1", {
    name: "model.response_process",
    category: "agent",
    track: "Main thread",
  });
  recorder.endSpan(responseProcessing, "ok");
  const model = recorder.startSpan("task-1", {
    name: "llm.request",
    category: "llm",
    track: "Main thread",
    attributes: { inputChars: 42, forbiddenPrompt: "x".repeat(600) },
  });
  recorder.instant("task-1", "llm.first_output", "llm", "Main thread", {
    chars: 3,
  });
  recorder.endSpan(model, "ok", { outputChars: 3 });
  const batch = recorder.startSpan("task-1", {
    name: "tool.batch",
    category: "tool",
    track: "Tool scheduler",
  });
  recorder.endSpan(batch, "ok");
  const tool = recorder.startSpan("task-1", {
    name: "tool.read_file",
    category: "tool",
    track: "Tool worker 1",
    attributes: {
      parameters: {
        authorization: "Bearer trace-secret",
        path: "src/tracing/recorder.ts",
      },
    },
  });
  recorder.endSpan(tool, "ok");
  recorder.link(model, tool, "llm_to_tool");
  recorder.endSpan(task, "ok");
  recorder.finishTask("task-1", "ok");

  const exported = recorder.exportTask("task-1");

  expect(exported?.metadata).toMatchObject({
    taskId: "task-1",
    sessionId: "session-1",
  });
  expect(exported?.traceEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "task.run", ph: "X", cat: "agent" }),
      expect.objectContaining({ name: "llm.request", ph: "B", cat: "llm" }),
      expect.objectContaining({ name: "llm.request", ph: "E", cat: "llm" }),
      expect.objectContaining({ name: "tool.batch", ph: "X", cat: "tool" }),
      expect.objectContaining({ name: "llm.first_output", ph: "i" }),
      expect.objectContaining({ name: "llm_to_tool", ph: "s" }),
      expect.objectContaining({ name: "llm_to_tool", ph: "f" }),
    ]),
  );
  const timelineEvents = exported?.traceEvents.filter(
    (event: { ts?: number }) => event.ts !== undefined,
  );
  expect(
    timelineEvents?.every(
      (event: { id?: unknown; ph: string }) =>
        (event.ph !== "s" && event.ph !== "f") ||
        (typeof event.id === "number" && Number.isSafeInteger(event.id)),
    ),
  ).toBe(true);
  expect(
    timelineEvents?.every(
      (event: { ts: number }, index: number, events: Array<{ ts: number }>) =>
        index === 0 || events[index - 1].ts <= event.ts,
    ),
  ).toBe(true);
  const flowEvents =
    timelineEvents?.filter(
      (event: { ph: string }) => event.ph === "s" || event.ph === "f",
    ) ?? [];
  expect(flowEvents).toHaveLength(2);
  expect(flowEvents[0].id).toBe(flowEvents[1].id);
  expect(flowEvents[0].ts).toBeLessThanOrEqual(flowEvents[1].ts);
  const completeEventsByTrack = new Map<
    number,
    Array<{ ts: number; dur: number }>
  >();
  for (const event of timelineEvents?.filter(
    (candidate: { ph: string }) => candidate.ph === "X",
  ) ?? []) {
    const completeEvent = event as { tid: number; ts: number; dur: number };
    const trackEvents = completeEventsByTrack.get(completeEvent.tid) ?? [];
    trackEvents.push(completeEvent);
    completeEventsByTrack.set(completeEvent.tid, trackEvents);
  }

  for (const trackEvents of completeEventsByTrack.values()) {
    trackEvents.sort((left, right) => left.ts - right.ts);
    for (let index = 1; index < trackEvents.length; index++) {
      const previous = trackEvents[index - 1];
      const current = trackEvents[index];
      expect(previous.ts + previous.dur).toBeLessThanOrEqual(current.ts);
    }
  }

  const taskTrack = exported?.traceEvents.find(
    (event: { name: string; ph: string; args: { name?: string } }) =>
      event.name === "thread_name" &&
      event.ph === "M" &&
      event.args.name === "Task",
  );
  const mainThreadTrack = exported?.traceEvents.find(
    (event: { name: string; ph: string; args: { name?: string } }) =>
      event.name === "thread_name" &&
      event.ph === "M" &&
      event.args.name === "Main thread",
  );
  expect(taskTrack.tid).not.toBe(mainThreadTrack.tid);
  const request = exported?.traceEvents.find(
    (event: { name: string; ph: string }) =>
      event.name === "llm.request" && event.ph === "B",
  );
  expect(request.args.forbiddenPrompt).toHaveLength(500);
  const toolEvent = exported?.traceEvents.find(
    (event: { name: string; ph: string }) =>
      event.name === "tool.read_file" && event.ph === "X",
  );
  expect(toolEvent.args.parameters).toEqual({
    authorization: "[REDACTED]",
    path: "src/tracing/recorder.ts",
  });
});

it("persists each Engine task trace by session and task, then exports it only through the authenticated local API", async () => {
  const config = new Config(await temp());
  const workspace = await temp();
  await writeFile(path.join(workspace, "trace-target.txt"), "trace target\n");
  let modelCalls = 0;
  const fixture = await createApp(config, pino({ enabled: false }), () => ({
    async run() {
      modelCalls++;
      if (modelCalls === 1) {
        return {
          output: [
            ...Array.from({ length: 5 }, (_, index) => ({
              type: "function_call" as const,
              call_id: `read-trace-target-${index + 1}`,
              name: "read_file",
              arguments: JSON.stringify({
                path: "trace-target.txt",
                startLine: 1,
                endLine: 1,
              }),
            })),
          ],
          text: "",
        };
      }

      return { output: [], text: "done" };
    },
  }));

  try {
    const bootstrap = await fixture.app.inject({
      url: "/api/bootstrap",
      headers: { host: "127.0.0.1" },
    });
    const token = bootstrap.json().token;
    const headers = {
      host: "127.0.0.1",
      cookie: "ca_session=" + token,
      "x-codeatelier-token": token,
    };
    const session = fixture.store.create(workspace, "trace test");
    const task = fixture.engine.start(session.id, "answer briefly");

    await fixture.engine.active?.done;

    const archivePath = path.join(
      config.directory,
      "traces",
      session.id,
      task.id + ".json",
    );
    const archivedTrace = JSON.parse(await readFile(archivePath, "utf8"));
    expect(archivedTrace.metadata).toMatchObject({
      taskId: task.id,
      sessionId: session.id,
    });
    expect(fixture.engine.traces.exportTask(task.id)).toBeUndefined();

    const traceList = await fixture.app.inject({
      url: `/api/sessions/${session.id}/traces`,
      headers,
    });
    expect(traceList.json().taskIds).toContain(task.id);

    expect(
      await fixture.app.inject({ url: `/api/tasks/${task.id}/trace` }),
    ).toMatchObject({ statusCode: 401 });
    const response = await fixture.app.inject({
      url: `/api/tasks/${task.id}/trace`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain(task.id);
    expect(response.json().traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "task.run", ph: "X" }),
        expect.objectContaining({ name: "context.prepare", ph: "B" }),
        expect.objectContaining({ name: "context.request", ph: "B" }),
        expect.objectContaining({ name: "llm.request", ph: "B" }),
        expect.objectContaining({ name: "model.response_process", ph: "B" }),
        expect.objectContaining({ name: "tool.plan", ph: "B" }),
        expect.objectContaining({ name: "tool.batch", ph: "X" }),
        expect.objectContaining({ name: "tool.read_file", ph: "X" }),
        expect.objectContaining({ name: "tool.result_persist", ph: "B" }),
        expect.objectContaining({ name: "llm_to_tool", ph: "s" }),
        expect.objectContaining({ name: "llm_to_tool", ph: "f" }),
      ]),
    );
    const toolTracks = response
      .json()
      .traceEvents.filter(
        (event: { name: string; ph: string; args: { name?: string } }) =>
          event.name === "thread_name" &&
          event.ph === "M" &&
          event.args.name?.startsWith("Tool worker "),
      );
    expect(toolTracks).toHaveLength(4);
    const mainThreadTrack = response
      .json()
      .traceEvents.find(
        (event: { name: string; ph: string; args: { name?: string } }) =>
          event.name === "thread_name" &&
          event.ph === "M" &&
          event.args.name === "Main thread",
      );
    const mainThreadNames = response
      .json()
      .traceEvents.filter(
        (event: { tid: number; ph: string }) =>
          event.tid === mainThreadTrack.tid && event.ph === "B",
      )
      .map((event: { name: string }) => event.name);
    expect(mainThreadNames).toEqual(
      expect.arrayContaining([
        "context.prepare",
        "context.prepare.measure_request_view",
        "context.request",
        "context.request.measure_before",
        "context.request.mechanical_input",
        "llm.request",
        "model.response_process",
        "tool.plan",
        "tool.result_persist",
      ]),
    );
    const mainThreadSlices = response
      .json()
      .traceEvents.filter(
        (event: { tid: number; ph: string }) =>
          event.tid === mainThreadTrack.tid &&
          (event.ph === "B" || event.ph === "E"),
      );
    const sliceIndex = (name: string, phase: "B" | "E") =>
      mainThreadSlices.findIndex(
        (event: { name: string; ph: string }) =>
          event.name === name && event.ph === phase,
      );

    const prepareBegin = sliceIndex("context.prepare", "B");
    const prepareMeasureBegin = sliceIndex(
      "context.prepare.measure_request_view",
      "B",
    );
    const prepareMeasureEnd = sliceIndex(
      "context.prepare.measure_request_view",
      "E",
    );
    const prepareEnd = sliceIndex("context.prepare", "E");
    const requestBegin = sliceIndex("context.request", "B");
    const requestEnd = sliceIndex("context.request", "E");
    const modelBegin = sliceIndex("llm.request", "B");
    expect(prepareMeasureBegin).toBeGreaterThan(prepareBegin);
    expect(prepareMeasureEnd).toBeGreaterThan(prepareMeasureBegin);
    expect(prepareEnd).toBeGreaterThan(prepareMeasureEnd);
    expect(requestBegin).toBeGreaterThan(prepareEnd);
    expect(requestEnd).toBeGreaterThan(requestBegin);
    expect(modelBegin).toBeGreaterThan(requestEnd);

    const mechanicalStage = response
      .json()
      .traceEvents.find(
        (event: { name: string; ph: string }) =>
          event.name === "context.request.mechanical_input" && event.ph === "B",
      );
    expect(mechanicalStage.args).toMatchObject({
      inputItems: expect.any(Number),
    });
    expect(JSON.stringify(mechanicalStage.args)).not.toContain(
      "answer briefly",
    );

    const tool = response
      .json()
      .traceEvents.find(
        (event: { name: string; ph: string }) =>
          event.name === "tool.read_file" && event.ph === "X",
      );
    expect(tool.args.parameters).toEqual({
      path: "trace-target.txt",
      startLine: 1,
      endLine: 1,
      whitespaceMode: false,
    });
  } finally {
    await fixture.app.close();
  }
});
