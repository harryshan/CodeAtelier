/**
 * 验证 Perfetto tracing 的可导出时间线、敏感原文边界、会话/任务级持久化和真实 HTTP 下载接口。
 * 第一组直接驱动 TraceRecorder，检查 span、instant 与 flow 被转换为 Chrome Trace Event JSON；
 * 第二组通过生产 createApp、Engine 和模拟模型完成任务，确认模型调用与任务根 span 写入数据目录后即释放内存，并可经本机受保护 API 和真实文件清单下载。
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
  const model = recorder.startSpan("task-1", {
    name: "llm.request",
    category: "llm",
    track: "LLM",
    attributes: { inputChars: 42, forbiddenPrompt: "x".repeat(600) },
  });
  recorder.instant("task-1", "llm.first_output", "llm", "LLM", { chars: 3 });
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
    track: "Tool call-1",
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
      expect.objectContaining({ name: "llm.request", ph: "X", cat: "llm" }),
      expect.objectContaining({ name: "tool.batch", ph: "X", cat: "tool" }),
      expect.objectContaining({ name: "llm.first_output", ph: "i" }),
      expect.objectContaining({ name: "llm_to_tool", ph: "s" }),
      expect.objectContaining({ name: "llm_to_tool", ph: "f" }),
    ]),
  );
  const request = exported?.traceEvents.find(
    (event: { name: string; ph: string }) =>
      event.name === "llm.request" && event.ph === "X",
  );
  expect(request.args.forbiddenPrompt).toHaveLength(500);
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
            {
              type: "function_call",
              call_id: "read-trace-target",
              name: "read_file",
              arguments: JSON.stringify({
                path: "trace-target.txt",
                startLine: 1,
                endLine: 1,
              }),
            },
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
        expect.objectContaining({ name: "llm.request", ph: "X" }),
        expect.objectContaining({ name: "tool.batch", ph: "X" }),
        expect.objectContaining({ name: "tool.read_file", ph: "X" }),
        expect.objectContaining({ name: "llm_to_tool", ph: "s" }),
        expect.objectContaining({ name: "llm_to_tool", ph: "f" }),
      ]),
    );
  } finally {
    await fixture.app.close();
  }
});
