/**
 * 覆盖首条用户消息自动标题的存储、低成本模型路由和失败降级。
 * 使用临时 SQLite、生产 Engine 与可观察的模拟 ModelProvider，不连接真实模型服务。
 *
 * 1. 新会话从 pending 占位标题开始；首个任务选择 auxiliaryModel，清理并保存模型返回的标题。
 * 2. 后续任务不会再次调用标题模型，避免用后续 prompt 覆盖首条消息的摘要。
 * 3. 标题模型对未知故障最多额外重试三次；耗尽或首任务取消时保留占位标题并结束标题状态。
 * 4. 用旧版 sessions 表启动 Store，确认迁移保留已有手填标题而不重新生成。
 *
 * 标题输出和模型调用只用于断言；测试不记录真实 prompt、密钥或外部服务数据。
 */

import { expect, it, vi } from "vitest";
import path from "node:path";
import pino from "pino";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { Store } from "../src/sessions/store.js";
import { TITLE_INSTRUCTIONS } from "../src/sessions/title-generator.js";
import { ModelError } from "../src/providers/model-error.js";
import { temp } from "./fixtures/helpers.js";

const completedTask = {
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "任务完成" }],
    },
  ],
  text: "任务完成",
};

it("generates and persists one title from the first prompt with the auxiliary model", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const session = store.create(await temp());
  const calls: Array<{ model: string; purpose: string }> = [];

  config.settings.auxiliaryModel = "low-cost-model";
  config.settings.auxiliaryReasoningEffort = "low";
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    (settings, purpose) => {
      calls.push({ model: settings.model, purpose });

      if (purpose === "auxiliary") {
        return {
          async run(input, instructions, tools, _signal, _onDelta, options) {
            expect(input).toEqual([
              {
                role: "user",
                content: "<user_prompt>\n修复登录失败\n</user_prompt>",
              },
            ]);
            expect(instructions).toContain(TITLE_INSTRUCTIONS);
            expect(tools).toEqual([]);
            expect(options).toEqual({ maxOutputTokens: 64 });

            return { output: [], text: "# 标题：修复登录失败\n不要保留这一行" };
          },
        };
      }

      return {
        async run() {
          return completedTask;
        },
      };
    },
  );

  try {
    expect(session).toMatchObject({ title: "新对话", titleState: "pending" });
    engine.start(session.id, "修复登录失败");
    await engine.active?.done;

    expect(store.get(session.id)).toMatchObject({
      title: "修复登录失败",
      titleState: "completed",
    });
    expect(calls).toEqual([
      { model: "low-cost-model", purpose: "auxiliary" },
      { model: config.settings.model, purpose: "task" },
    ]);

    engine.start(session.id, "补充回归测试");
    await engine.active?.done;

    expect(store.get(session.id)?.title).toBe("修复登录失败");
    expect(calls.filter((call) => call.purpose === "auxiliary")).toHaveLength(
      1,
    );
  } finally {
    await engine.close();
    store.close();
  }
});

it("retries unknown title failures up to three times before completing the coding task", async () => {
  vi.useFakeTimers();
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const session = store.create(await temp());
  let titleCalls = 0;
  let taskCalls = 0;
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    (_settings, purpose) =>
      purpose === "auxiliary"
        ? {
            async run() {
              titleCalls++;
              if (titleCalls <= 3) {
                throw new Error("title service temporarily unavailable");
              }

              return { output: [], text: "构建失败排查" };
            },
          }
        : {
            async run() {
              taskCalls++;

              return completedTask;
            },
          },
  );

  try {
    engine.start(session.id, "检查构建失败");
    await vi.runAllTimersAsync();
    await engine.active?.done;

    expect(titleCalls).toBe(4);
    expect(taskCalls).toBe(1);
    expect(store.get(session.id)).toMatchObject({
      title: "构建失败排查",
      titleState: "completed",
    });
  } finally {
    vi.useRealTimers();
    await engine.close();
    store.close();
  }
});

it("keeps the placeholder title when permanent generation failure does not fail the coding task", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const session = store.create(await temp());
  let taskCalls = 0;
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    (_settings, purpose) =>
      purpose === "auxiliary"
        ? {
            async run() {
              throw new ModelError(
                "title model is unavailable",
                false,
                "http_400",
              );
            },
          }
        : {
            async run() {
              taskCalls++;

              return completedTask;
            },
          },
  );

  try {
    engine.start(session.id, "检查构建失败");
    await engine.active?.done;

    expect(taskCalls).toBe(1);
    expect(store.get(session.id)).toMatchObject({
      title: "新对话",
      titleState: "failed",
    });
    expect(store.tasks(session.id)[0].status).toBe("completed");
  } finally {
    await engine.close();
    store.close();
  }
});

it("ends title generation when the first task is cancelled", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "history.sqlite"));
  const session = store.create(await temp());
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    (_settings, purpose) =>
      purpose === "auxiliary"
        ? {
            async run(_input, _instructions, _tools, signal) {
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });

              return { output: [], text: "不应返回" };
            },
          }
        : {
            async run() {
              throw new Error("标题取消后不应执行主任务");
            },
          },
  );

  try {
    const task = engine.start(session.id, "取消中的标题请求");

    engine.cancel(task.id);
    await engine.active?.done;

    expect(store.get(session.id)).toMatchObject({
      title: "新对话",
      titleState: "failed",
    });
    expect(store.task(task.id)?.status).toBe("cancelled");
  } finally {
    await engine.close();
    store.close();
  }
});

it("marks sessions from the old schema as completed to preserve existing titles", async () => {
  const directory = await temp();
  const file = path.join(directory, "history.sqlite");
  const legacy = new DatabaseSync(file);

  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    INSERT INTO sessions VALUES ('old', '保留的历史标题', 'C:/project', '2026-01-01', '2026-01-01');
  `);
  legacy.close();

  const store = new Store(file);
  try {
    expect(store.get("old")).toMatchObject({
      title: "保留的历史标题",
      titleState: "completed",
    });
  } finally {
    store.close();
  }
});
