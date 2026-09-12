/**
 * 文件作用：验证生产 Engine 的任务约束和模型工具反馈行为。
 * 代码结构：先定义模拟结果与引擎夹具，再覆盖步数和容量、参数失败、项目规则、跨任务重新读取及凭据相关源码的 JSON 完整性。
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

it("loads project guidance and bounds large tool feedback", async () => {
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
              name: "edit_file",
              arguments: JSON.stringify({
                path: "a.txt",
                oldText: "old",
                newText: "new",
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
