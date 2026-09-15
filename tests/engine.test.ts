/**
 * 用模拟模型驱动生产 Engine，检查任务限制和工具结果反馈。
 * createFixture 提供临时 Store，断言读取实际文件、事件和任务状态。
 *
 * 1. 检查达到步数或上下文上限时会停止，已经完成的工具结果仍然保存。
 * 2. 传入非法工具参数，确认错误返回模型且文件没有变化。
 * 3. 检查项目规则加载、大输出限制，以及多项互不冲突的工具调用会在同一轮全部执行。
 * 4. 检查多文件调用的逐文件进度及结果持久化、新任务必须重新读文件，以及含凭据相关源码的工具结果仍是合法 JSON。
 *
 * 只模拟模型响应，文件操作、审批和保存使用实际实现。
 */

import { it, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { Engine } from "../src/agent/engine.js";
import { Store } from "../src/sessions/store.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { temp } from "./fixtures/helpers.js";

const done = {
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  ],
  text: "done",
};

async function createFixture(provider: ModelProvider) {
  const root = await temp();
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "db"));
  const session = store.create(root, "test");
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
  );

  return { root, config, store, session, engine };
}

it("enforces step budget after saving completed tool results", async () => {
  let calls = 0;
  const fixture = await createFixture({
    async run() {
      calls++;

      return {
        output: [
          {
            type: "function_call",
            call_id: "list",
            name: "list_files",
            arguments: '{"path":"."}',
          },
        ],
        text: "",
      };
    },
  });

  try {
    fixture.config.settings.maxSteps = 1;
    fixture.engine.start(fixture.session.id, "list");
    await fixture.engine.active?.done;

    expect(calls).toBe(1);
    expect(fixture.store.tasks(fixture.session.id)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("最大模型调用"),
    });
    expect(
      fixture.store
        .context(fixture.session.id)
        .some((i) => i.type === "function_call_output"),
    ).toBe(true);
    expect(fixture.engine.active).toBeUndefined();
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("executes every independent tool call returned in one model response", async () => {
  let calls = 0;
  const fixture = await createFixture({
    async run() {
      if (++calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "first-write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "first.txt",
                content: "first file\n",
              }),
            },
            {
              type: "function_call",
              call_id: "second-write",
              name: "write_file",
              arguments: JSON.stringify({
                path: "second.txt",
                content: "second file\n",
              }),
            },
          ],
          text: "",
        };
      }

      return done;
    },
  });

  try {
    fixture.engine.start(fixture.session.id, "create both files");
    await fixture.engine.active?.done;

    expect(calls).toBe(2);
    expect(await readFile(path.join(fixture.root, "first.txt"), "utf8")).toBe(
      "first file\n",
    );
    expect(await readFile(path.join(fixture.root, "second.txt"), "utf8")).toBe(
      "second file\n",
    );
    expect(
      fixture.store
        .events(fixture.session.id)
        .filter((event) => event.type === "tool_result"),
    ).toHaveLength(2);
    expect(fixture.store.tasks(fixture.session.id)[0].status).toBe("completed");
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("fails an over-budget context before calling the provider", async () => {
  let calls = 0;
  const fixture = await createFixture({
    async run() {
      calls++;

      return done;
    },
  });

  try {
    fixture.config.settings.contextChars = 10000;
    fixture.engine.start(fixture.session.id, "x".repeat(11000));
    await fixture.engine.active?.done;

    expect(calls).toBe(0);
    expect(fixture.store.tasks(fixture.session.id)[0].error).toContain(
      "上下文",
    );
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("returns invalid tool arguments as model feedback without mutating files", async () => {
  let calls = 0;
  let feedback = "";
  const fixture = await createFixture({
    async run(input) {
      if (++calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "bad",
              name: "write_file",
              arguments: "not-json",
            },
          ],
          text: "",
        };
      }

      feedback = input.find((i) => i.type === "function_call_output").output;

      return done;
    },
  });

  try {
    fixture.engine.start(fixture.session.id, "test");
    await fixture.engine.active?.done;

    expect(JSON.parse(feedback).error).toBeTruthy();
    expect(fixture.store.tasks(fixture.session.id)[0].status).toBe("completed");
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("loads project guidance, encourages independent batches, and bounds large tool feedback", async () => {
  let calls = 0;
  let guidance = "";
  let result: any;
  const fixture = await createFixture({
    async run(input, instructions) {
      guidance = instructions;
      if (++calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "read",
              name: "read_file",
              arguments: JSON.stringify({
                path: "long.txt",
                startLine: 1,
                endLine: 10,
              }),
            },
          ],
          text: "",
        };
      }

      result = JSON.parse(
        input.find((i) => i.type === "function_call_output").output,
      );

      return done;
    },
  });

  try {
    fixture.config.settings.outputChars = 1000;
    await writeFile(
      path.join(fixture.root, "AGENTS.md"),
      "Project convention: use meaningful tests.",
    );
    await writeFile(path.join(fixture.root, "long.txt"), "x".repeat(5000));
    fixture.engine.start(fixture.session.id, "read");
    await fixture.engine.active?.done;

    expect(guidance).toContain("Project convention");
    expect(guidance).toContain("Complete the user's whole request");
    expect(guidance).toContain("multiple independent tool calls");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(1000);
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("requires a fresh read in a later task even when history contains an earlier read", async () => {
  let calls = 0;
  const fixture = await createFixture({
    async run() {
      calls++;
      if (calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "read",
              name: "read_file",
              arguments: JSON.stringify({
                path: "a.txt",
                startLine: 1,
                endLine: 10,
              }),
            },
          ],
          text: "",
        };
      }

      if (calls === 3) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "edit",
              name: "edit_files",
              arguments: JSON.stringify({
                files: [
                  {
                    path: "a.txt",
                    edits: [{ oldText: "old", newText: "new" }],
                  },
                ],
              }),
            },
          ],
          text: "",
        };
      }

      return done;
    },
  });

  try {
    await writeFile(path.join(fixture.root, "a.txt"), "old");
    fixture.engine.start(fixture.session.id, "read");
    await fixture.engine.active?.done;
    fixture.engine.start(fixture.session.id, "edit");
    await fixture.engine.active?.done;

    expect(await readFile(path.join(fixture.root, "a.txt"), "utf8")).toBe(
      "old",
    );
    expect(
      fixture.store
        .events(fixture.session.id)
        .some(
          (e) =>
            e.type === "tool_result" &&
            e.data.result?.error?.includes("未读取"),
        ),
    ).toBe(true);
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("reads credential-related source without corrupting tool-result JSON", async () => {
  let calls = 0;
  const fixture = await createFixture({
    async run(input) {
      if (calls++ === 0) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "source",
              name: "read_file",
              arguments: JSON.stringify({
                path: "example.ts",
                startLine: 1,
                endLine: 20,
              }),
            },
          ],
          text: "",
        };
      }

      const output = input.find((item) => item.type === "function_call_output");
      expect(JSON.parse(output.output).text).toContain("const result = 42;");
      expect(output.output).not.toContain("known-runtime-secret");

      return done;
    },
  });

  try {
    fixture.config.apiKey = "known-runtime-secret";
    await writeFile(
      path.join(fixture.root, "example.ts"),
      'const config = { apiKey: "example-key" };\nconst secret = "known-runtime-secret";\nconst result = 42;\n',
    );
    fixture.engine.start(fixture.session.id, "read source");
    await fixture.engine.active?.done;

    expect(fixture.store.tasks(fixture.session.id)[0].status).toBe("completed");
    expect(calls).toBe(2);
    const result = fixture.store
      .events(fixture.session.id)
      .find((event) => event.type === "tool_result");
    expect(result?.data.result.text).toContain("const result = 42;");
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("persists multi-file progress with the call id and returns one batch result", async () => {
  let calls = 0;
  let result: any;
  const fixture = await createFixture({
    async run(input) {
      calls++;
      if (calls === 1) {
        return {
          text: "",
          output: ["a.txt", "b.txt"].map((name) => ({
            type: "function_call",
            name: "read_file",
            call_id: name,
            arguments: JSON.stringify({ path: name, startLine: 1, endLine: 1 }),
          })),
        };
      }

      if (calls === 2) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              name: "edit_files",
              call_id: "batch-edit",
              arguments: JSON.stringify({
                files: ["a.txt", "b.txt"].map((name) => ({
                  path: name,
                  edits: [
                    {
                      oldText: "old",
                      newText: "new",
                      startLine: 1,
                      endLine: 1,
                    },
                  ],
                })),
              }),
            },
          ],
        };
      }

      result = JSON.parse(
        input.find(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "batch-edit",
        ).output,
      );

      return done;
    },
  });
  try {
    for (const name of ["a.txt", "b.txt"]) {
      await writeFile(path.join(fixture.root, name), "old");
    }

    fixture.engine.start(fixture.session.id, "edit both files");
    await fixture.engine.active?.done;
    expect(calls).toBe(3);
    expect(result.files.map((file: any) => file.status)).toEqual([
      "written",
      "written",
    ]);
    const progress = fixture.store
      .events(fixture.session.id)
      .filter(
        (event) =>
          event.type === "edit_progress" && event.data.status === "written",
      );
    expect(progress).toHaveLength(2);
    expect(progress.every((event) => event.data.callId === "batch-edit")).toBe(
      true,
    );
    for (const name of ["a.txt", "b.txt"]) {
      expect(await readFile(path.join(fixture.root, name), "utf8")).toBe("new");
    }
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});
