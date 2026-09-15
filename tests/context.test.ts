/**
 * 检查历史压缩、快照读取，以及压缩之后的任务执行和恢复。
 * 组合真实 ContextManager、Store 与模拟模型，核对保存的记录和最终任务状态。
 *
 * 1. history/fixture 创建长历史，先检查切分不会拆散工具调用和结果。
 * 2. 检查用户原话和纠正、归档正文、未知结果在多次压缩及重启后仍可读取。
 * 3. 模拟摘要失败、数据库失败和取消，检查快照与活动上下文是否一起保存或一起回滚。
 * 4. 驱动 Engine 验证压缩后继续执行、历史分页和上下文超限重试，区分不同尝试的记录。
 * 5. 检查重复调用 ID、已保存的错误和明确的超限错误码，防止误判执行结果。
 *
 * 所有模型响应都是模拟数据。缺少执行结果的记录必须保持未知，不能被摘要改写为成功。
 */

import { ModelError, modelError } from "../src/providers/model-error.js";
import { expect, it, vi } from "vitest";
import path from "node:path";
import pino from "pino";
import { ContextManager } from "../src/context/context-manager.js";
import { contextSize, safeCuts } from "../src/context/budget.js";
import {
  historyDefinition,
  readContextHistory,
} from "../src/context/history.js";
import { Store } from "../src/sessions/store.js";
import { Engine } from "../src/agent/engine.js";
import { createInstructions } from "../src/agent/instructions.js";
import { definitions } from "../src/tools/registry.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { temp } from "./fixtures/helpers.js";

const summary = {
  completed: [],
  conclusions: [],
  verification: [],
  pending: [],
};
const summarizer: ModelProvider = {
  async run(input, _instructions, tools) {
    expect(tools).toEqual([]);
    const records = JSON.parse(input[0].content);

    return {
      output: [],
      text: JSON.stringify({
        ...summary,
        pending: [
          { text: "继续读取当前文件并验证", sources: [records[0].index] },
        ],
      }),
    };
  },
};

function history() {
  return [
    { role: "user", content: "修复问题，不改变公开接口" },
    { role: "assistant", content: "old code ".repeat(2000) },
    { role: "user", content: "补充：保持中文错误提示" },
  ];
}

async function fixture(provider = summarizer, limit = 12000) {
  const file = path.join(await temp(), "context.db");
  const store = new Store(file);
  const session = store.create(await temp(), "context");
  const controller = new AbortController();
  const notices: string[] = [];
  const manager = new ContextManager({
    store,
    sessionId: session.id,
    model: "test",
    limit,
    provider,
    signal: controller.signal,
    clean: (text) => text,
    notice: (text) => notices.push(text),
    report: () => {},
  });

  return { file, store, session, controller, notices, manager };
}

it("counts tool definitions and preserves entire tool batches at cut boundaries", () => {
  expect(contextSize([], "rules", [{ name: "tool" }])).toBeGreaterThan(
    contextSize([], "rules", []),
  );
  const items = [
    { role: "user", content: "task" },
    { type: "reasoning", id: "r" },
    { type: "function_call", call_id: "a" },
    { type: "function_call", call_id: "b" },
    { type: "function_call_output", call_id: "a", output: "ok" },
    { type: "function_call_output", call_id: "b", output: "ok" },
    { role: "assistant", content: "done" },
    { role: "user", content: "next" },
  ];
  expect(safeCuts(items)).toEqual([6, 7]);
});

it("compacts history, preserves user corrections and reloads exact archive after restart", async () => {
  const f = await fixture();
  const source = history();
  f.store.saveContext(f.session.id, source);
  const event = f.store.event(f.session.id, "task", "user", {
    text: "original",
  });
  let reopened: Store | undefined;
  try {
    const next = await f.manager.prepare(source, "rules", []);
    expect(contextSize(next, "rules", [])).toBeLessThan(7200);
    expect(next.filter((item) => item.role === "user")).toEqual(
      source.filter((item) => item.role === "user"),
    );
    expect(f.store.events(f.session.id)).toEqual([event]);
    const snapshot = f.store.latestContextSnapshot(f.session.id)!;
    expect(snapshot.source).toEqual(source);
    f.store.close();
    reopened = new Store(f.file);
    expect(reopened.context(f.session.id)).toEqual(next);
    let offset = 0;
    let text = "";
    do {
      const page = readContextHistory(
        reopened,
        f.session.id,
        { snapshotId: snapshot.id, index: 1, offset },
        1000,
      );
      expect(JSON.stringify(page).length).toBeLessThan(1000);
      text += page.text;
      if (page.nextOffset === null) {
        break;
      }

      offset = page.nextOffset;
    } while (true);

    expect(JSON.parse(text)).toEqual(source[1]);
    const other = reopened.create(await temp(), "other");
    expect(() =>
      readContextHistory(
        reopened!,
        other.id,
        { snapshotId: snapshot.id, index: 1, offset: 0 },
        1000,
      ),
    ).toThrow("当前会话");
  } finally {
    (reopened ?? f.store).close();
  }
});

it("keeps unknown operation state across repeated compaction without executing tools", async () => {
  const f = await fixture();
  try {
    const source = [
      { role: "user", content: "task" },
      {
        type: "function_call",
        call_id: "unknown",
        name: "run_command",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "unknown",
        output: "执行结果未知",
      },
      { role: "assistant", content: "x".repeat(15000) },
      { role: "user", content: "continue" },
    ];
    const first = await f.manager.prepare(source, "", []);
    const next = [
      ...first,
      { role: "assistant", content: "y".repeat(15000) },
      { role: "user", content: "again" },
    ];
    await f.manager.prepare(next, "", []);
    const snapshot = f.store.latestContextSnapshot(f.session.id)!;
    expect(snapshot.parentId).not.toBeNull();
    expect(snapshot.ledger).toContainEqual(
      expect.objectContaining({ callId: "unknown", status: "unknown" }),
    );
    expect(JSON.stringify(f.store.context(f.session.id))).toContain(
      "不可盲目重放",
    );
  } finally {
    f.store.close();
  }
});

it.each([
  "invalid JSON",
  JSON.stringify({
    ...summary,
    pending: [{ text: "invented", sources: [999] }],
  }),
])(
  "rejects malformed or ungrounded summaries and preserves the original context: %s",
  async (text) => {
    const f = await fixture({
      async run() {
        return { output: [], text };
      },
    });
    try {
      const source = history();
      f.store.saveContext(f.session.id, source);
      await expect(f.manager.prepare(source, "", [])).rejects.toThrow("上下文");
      expect(f.store.context(f.session.id)).toEqual(source);
      expect(f.store.latestContextSnapshot(f.session.id)).toBeUndefined();
    } finally {
      f.store.close();
    }
  },
);

it("continues below the hard limit after summary failure and does not repeatedly summarize", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      throw new Error("fail");
    },
  });
  try {
    const source = history();
    source[1].content = "x".repeat(10000);
    expect(await f.manager.prepare(source, "", [])).toBe(source);
    expect(await f.manager.prepare(source, "", [])).toBe(source);
    expect(calls).toBe(1);
  } finally {
    f.store.close();
  }
});

it("rolls back archive creation if replacing active context fails", async () => {
  const f = await fixture();
  try {
    const source = history();
    f.store.saveContext(f.session.id, source);
    const save = vi
      .spyOn(f.store, "compactContextAsync")
      .mockRejectedValue(new Error("disk failure"));
    await expect(f.manager.prepare(source, "", [])).rejects.toThrow("上下文");
    save.mockRestore();
    expect(f.store.context(f.session.id)).toEqual(source);
    expect(f.store.latestContextSnapshot(f.session.id)).toBeUndefined();
  } finally {
    f.store.close();
  }
});

it("cancels summary work without replacing context or retrying", async () => {
  let abort = () => {};

  const f = await fixture({
    async run() {
      abort();

      return { output: [], text: JSON.stringify(summary) };
    },
  });
  abort = () => f.controller.abort(new Error("cancelled"));
  try {
    const source = history();
    f.store.saveContext(f.session.id, source);
    await expect(f.manager.prepare(source, "", [])).rejects.toThrow(
      "cancelled",
    );
    expect(f.store.context(f.session.id)).toEqual(source);
    expect(f.store.latestContextSnapshot(f.session.id)).toBeUndefined();
  } finally {
    f.store.close();
  }
});

it("rejects oversized current requirements without calling the summary model", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;

      return { output: [], text: "" };
    },
  });
  try {
    await expect(
      f.manager.prepare([{ role: "user", content: "x".repeat(15000) }], "", []),
    ).rejects.toThrow("上下文");
    expect(calls).toBe(0);
  } finally {
    f.store.close();
  }
});

it("continues an engine task after compression and exposes archived history as a bounded tool", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(await temp(), "db"));
  const session = store.create(await temp(), "integration");
  // 工具声明和指令不可压缩；按实际固定开销预留空间，仍强制历史超过触发阈值。
  const instructions = await createInstructions(session.workspace);
  const tools = [...definitions, historyDefinition];
  const overhead = contextSize([], instructions, tools);
  config.settings.contextChars = Math.ceil((overhead + 3000) / 0.6);
  expect(
    contextSize(history().slice(0, 2), instructions, tools),
  ).toBeGreaterThan(config.settings.contextChars * 0.8);
  store.saveContext(session.id, history().slice(0, 2));
  let turns = 0;
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input, instructions, tools, signal, delta) {
      if (!tools.length) {
        return summarizer.run(input, instructions, tools, signal, delta);
      }

      expect(tools.some((tool) => tool.name === "read_context_history")).toBe(
        true,
      );
      if (turns++ === 0) {
        const snapshot = store.latestContextSnapshot(session.id)!;
        expect(snapshot).toBeDefined();

        return {
          output: [
            {
              type: "function_call",
              name: "read_context_history",
              call_id: "archive",
              arguments: JSON.stringify({
                snapshotId: snapshot.id,
                index: 1,
                offset: 0,
              }),
            },
          ],
          text: "",
        };
      }

      expect(
        JSON.parse(
          input.findLast((item) => item.type === "function_call_output").output,
        ).text,
      ).toContain("old code");

      return { output: [{ role: "assistant", content: "done" }], text: "done" };
    },
  }));
  try {
    engine.start(session.id, "continue");
    await engine.active?.done;
    expect(
      store.tasks(session.id)[0].status,
      store.tasks(session.id)[0].error,
    ).toBe("completed");
    expect(
      store
        .events(session.id)
        .some(
          (event) =>
            event.type === "notice" && event.data.text.includes("已整理"),
        ),
    ).toBe(true);
  } finally {
    await engine.close();
    store.close();
  }
});

it("bounds summary calls and rejects tool requests from the summarizer", async () => {
  const f = await fixture({
    async run() {
      return {
        output: [{ type: "function_call", name: "write_file" }],
        text: JSON.stringify(summary),
      };
    },
  });
  try {
    f.store.saveContext(f.session.id, history());
    await expect(f.manager.prepare(history(), "", [])).rejects.toThrow(
      "上下文",
    );
    expect(f.store.latestContextSnapshot(f.session.id)).toBeUndefined();
  } finally {
    f.store.close();
  }
});

it("retains large histories when they cannot fit within the bounded summary call budget", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;

      return { output: [], text: JSON.stringify(summary) };
    },
  });
  try {
    const source = [
      { role: "user", content: "task" },
      ...Array.from({ length: 100 }, () => ({
        role: "assistant",
        content: "x".repeat(3000),
      })),
      { role: "user", content: "continue" },
    ];
    f.store.saveContext(f.session.id, source);
    await expect(f.manager.prepare(source, "", [])).rejects.toThrow("上下文");
    expect(calls).toBe(0);
    expect(f.store.context(f.session.id)).toEqual(source);
  } finally {
    f.store.close();
  }
});

it("retries server context overflow once and separates partial output attempts", async () => {
  const config = new Config(await temp());
  const store = new Store(path.join(await temp(), "db"));
  const session = store.create(await temp(), "overflow");
  store.saveContext(session.id, history().slice(0, 2));
  let calls = 0;
  const engine = new Engine(store, config, pino({ enabled: false }), () => ({
    async run(input, instructions, tools, signal, delta) {
      if (!tools.length) {
        return summarizer.run(input, instructions, tools, signal, delta);
      }

      calls++;
      delta(calls === 1 ? "failed partial" : "second partial");

      throw new ModelError("too large", false, "context_length_exceeded");
    },
  }));
  try {
    engine.start(session.id, "continue");
    await engine.active?.done;
    expect(calls).toBe(2);
    expect(store.tasks(session.id)[0].status).toBe("failed");
    const deltas = store
      .events(session.id)
      .filter((event) => event.type === "delta");
    expect(deltas.map((event) => event.data.attempt)).toEqual([1, 2]);
    expect(JSON.stringify(store.context(session.id))).not.toContain(
      "failed partial",
    );
  } finally {
    await engine.close();
    store.close();
  }
});

it("does not label an unknown operation as recorded when an older task reused its call ID", async () => {
  const f = await fixture();
  try {
    f.store.event(f.session.id, "older-task", "tool_result", {
      callId: "reused",
      name: "run_command",
      result: { exitCode: 0 },
    });
    const source = [
      { role: "user", content: "current task" },
      {
        type: "function_call",
        call_id: "reused",
        name: "run_command",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "reused",
        output: "执行结果未知",
      },
      { role: "assistant", content: "x".repeat(15000) },
      { role: "user", content: "continue" },
    ];
    await f.manager.prepare(source, "", []);
    expect(f.store.latestContextSnapshot(f.session.id)?.ledger).toContainEqual(
      expect.objectContaining({ callId: "reused", status: "unknown" }),
    );
  } finally {
    f.store.close();
  }
});

it("records exact persisted failures without converting them into success", async () => {
  const f = await fixture();
  try {
    const result = { exitCode: 1, error: "tests failed" };
    f.store.event(f.session.id, "task", "tool_result", {
      callId: "verified",
      name: "run_command",
      result,
    });
    const source = [
      { role: "user", content: "verify" },
      {
        type: "function_call",
        call_id: "verified",
        name: "run_command",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "verified",
        output: JSON.stringify(result),
      },
      { role: "assistant", content: "x".repeat(15000) },
      { role: "user", content: "continue" },
    ];
    await f.manager.prepare(source, "", []);
    const record = f.store.latestContextSnapshot(f.session.id)!.ledger[0];
    expect(record.status).toBe("recorded");
    expect(JSON.parse(record.result)).toEqual(result);
  } finally {
    f.store.close();
  }
});

it("only recognizes explicit provider context overflow codes", () => {
  expect(
    modelError({ status: 400, code: "context_length_exceeded" }).code,
  ).toBe("context_length_exceeded");
  expect(modelError({ status: 400, code: "invalid_request" }).code).toBe(
    "http_400",
  );
});
