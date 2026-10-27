/**
 * 异步存储让出事件循环时的调度/取消回归，使用生产 AsyncStore 和无副作用模型。
 * 1. 在排队任务读取用户事件时阻塞读回执，让取消完成提交。
 * 2. 释放读取后调度不得把 cancelled 改回 running，也不得调用模型或工具。
 * 3. 延迟 running 写入时仍只领取一次任务；去掉目录互斥后必须按 taskId 排除已领取项。
 */
import { test, expect, vi } from "vitest";
import path from "node:path";
import pino from "pino";
import { AsyncStore } from "../src/sessions/async-store.js";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import { temp } from "./fixtures/helpers.js";

test("claims a task only once while its running write is pending", async () => {
  const config = new Config(await temp());
  const store = await AsyncStore.open(
    path.join(config.directory, "history.sqlite"),
  );
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run() {
      return { output: [], text: "done" };
    },
  }));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runningWrites = 0;
  const status = store.statusAsync.bind(store);
  const delayed = vi
    .spyOn(store, "statusAsync")
    .mockImplementation(async (...args) => {
      if (args[1] === "running") {
        runningWrites++;
        // 旧实现第二次领取时释放，确保回归失败有界，而非无限重启模型或耗尽内存。
        if (runningWrites > 1) {
          release();
        }

        await blocked;
      }

      return status(...args);
    });

  try {
    const session = await store.createAsync(await temp());
    const { task } = await store.startTaskAsync(session.id, "run once", false);
    await (engine as unknown as { schedule(): Promise<void> }).schedule();
    expect(runningWrites).toBe(1);
    expect((await store.task(task.id))?.status).toBe("queued");
    release();
    await expect
      .poll(async () => (await store.task(task.id))?.status)
      .toBe("completed");
    expect(runningWrites).toBe(1);
  } finally {
    release();
    await engine.close();
    delayed.mockRestore();
    await store.closeAsync();
  }
});

test("cancellation wins while the scheduler awaits task metadata", async () => {
  const config = new Config(await temp());
  const store = await AsyncStore.open(
    path.join(config.directory, "history.sqlite"),
  );
  const model = vi.fn(async () => ({ output: [], text: "never" }));
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    run: model,
  }));
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const session = await store.createAsync(await temp());
    const { task } = await store.startTaskAsync(
      session.id,
      "cancel before start",
      false,
    );
    const read = store.taskEvent.bind(store);
    vi.spyOn(store, "taskEvent").mockImplementation(async (...args) => {
      entered();
      await blocked;

      return read(...args);
    });
    const scheduling = (
      engine as unknown as { schedule(): Promise<void> }
    ).schedule();
    await reading;
    await engine.cancelAsync(task.id);
    release();
    await scheduling;
    expect((await store.task(task.id))?.status).toBe("cancelled");
    expect(model).not.toHaveBeenCalled();
  } finally {
    release();
    await engine.close();
    await store.closeAsync();
  }
});
