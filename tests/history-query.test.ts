/**
 * 验证有界历史查询和持久化统计，不访问真实数据库或执行历史工具。
 * 1. 页面游标固定高水位，加载旧页时的新事件不混入旧页。
 * 2. 超大正文按片读取；统计覆盖页面外事件，恢复材料保留重复调用 ID。
 */
import { expect, test } from "vitest";
import path from "node:path";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

test("bounded pages preserve full statistics and complete recovery candidates", async () => {
  const store = new Store(path.join(await temp(), "history.sqlite"));
  try {
    const session = store.create(await temp());
    const task = store.createTask(session.id);
    for (let index = 0; index < 260; index++) {
      store.event(session.id, task.id, "tool_result", {
        callId: "same",
        name: "read_file",
        result: { text: "x".repeat(1000) },
      });
    }

    const page = store.historyPage(session.id, { limit: 20 });
    expect(page.events).toHaveLength(20);
    expect(page.hasOlder).toBe(true);
    const appended = store.event(session.id, task.id, "notice", {
      text: "new",
    });
    const older = store.historyPage(session.id, {
      before: page.events[0]!.id,
      highWater: page.highWater,
      limit: 20,
    });
    expect(older.events.every((event) => event.id < page.events[0]!.id)).toBe(
      true,
    );
    expect(older.highWater).toBeLessThan(appended.id);
    expect(store.statistics(session.id).completedToolCalls).toBe(260);
    expect(await store.relevantEventsAsync(session.id)).toHaveLength(260);
    const large = store.event(session.id, task.id, "notice", {
      text: "汉".repeat(50000),
    });
    expect(store.historyPage(session.id, {}).events.at(-1)?.bodyDeferred).toBe(
      true,
    );
    let text = "";
    let offset = 0;
    for (;;) {
      const part = store.eventBody(session.id, large.id, offset);
      text += part.text;
      if (part.next === null) {
        break;
      }

      offset = part.next;
    }

    expect(JSON.parse(text)).toEqual(large.data);
  } finally {
    await store.closeAsync();
  }
});
