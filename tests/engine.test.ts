import { it, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { Engine } from "../src/agent/engine.js";
import { Store } from "../src/sessions/store.js";
import { Config } from "../src/config/settings.js";
import type { ModelProvider } from "../src/providers/responses.js";
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
async function fixture(provider: ModelProvider) {
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
  const f = await fixture({
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
    f.config.settings.maxSteps = 1;
    f.engine.start(f.session.id, "list");
    await f.engine.active?.done;
    expect(calls).toBe(1);
    expect(f.store.tasks(f.session.id)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("最大模型调用"),
    });
    expect(
      f.store
        .context(f.session.id)
        .some((i) => i.type === "function_call_output"),
    ).toBe(true);
    expect(f.engine.active).toBeUndefined();
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
it("fails an over-budget context before calling the provider", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      return done;
    },
  });
  try {
    f.config.settings.contextChars = 10000;
    f.engine.start(f.session.id, "x".repeat(11000));
    await f.engine.active?.done;
    expect(calls).toBe(0);
    expect(f.store.tasks(f.session.id)[0].error).toContain("上下文");
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
it("returns invalid tool arguments as model feedback without mutating files", async () => {
  let calls = 0;
  let feedback = "";
  const f = await fixture({
    async run(input) {
      if (++calls === 1)
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
      feedback = input.find((i) => i.type === "function_call_output").output;
      return done;
    },
  });
  try {
    f.engine.start(f.session.id, "test");
    await f.engine.active?.done;
    expect(JSON.parse(feedback).error).toBeTruthy();
    expect(f.store.tasks(f.session.id)[0].status).toBe("completed");
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
it("loads project guidance and bounds large tool feedback", async () => {
  let calls = 0;
  let guidance = "";
  let result: any;
  const f = await fixture({
    async run(input, instructions) {
      guidance = instructions;
      if (++calls === 1)
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
      result = JSON.parse(
        input.find((i) => i.type === "function_call_output").output,
      );
      return done;
    },
  });
  try {
    f.config.settings.outputChars = 1000;
    await writeFile(
      path.join(f.root, "AGENTS.md"),
      "Project convention: use meaningful tests.",
    );
    await writeFile(path.join(f.root, "long.txt"), "x".repeat(5000));
    f.engine.start(f.session.id, "read");
    await f.engine.active?.done;
    expect(guidance).toContain("Project convention");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(1000);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
it("requires a fresh read in a later task even when history contains an earlier read", async () => {
  let calls = 0;
  const f = await fixture({
    async run() {
      calls++;
      if (calls === 1)
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
      if (calls === 3)
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
      return done;
    },
  });
  try {
    await writeFile(path.join(f.root, "a.txt"), "old");
    f.engine.start(f.session.id, "read");
    await f.engine.active?.done;
    f.engine.start(f.session.id, "edit");
    await f.engine.active?.done;
    expect(await readFile(path.join(f.root, "a.txt"), "utf8")).toBe("old");
    expect(
      f.store
        .events(f.session.id)
        .some(
          (e) =>
            e.type === "tool_result" &&
            e.data.result?.error?.includes("未读取"),
        ),
    ).toBe(true);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
