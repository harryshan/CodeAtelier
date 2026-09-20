/**
 * 用模拟模型驱动生产 Engine，检查任务限制和工具结果反馈。
 * createFixture 提供临时 Store，断言读取实际文件、事件和任务状态。
 *
 * 1. 检查达到步数或上下文上限时会停止，已经完成的工具结果仍然保存。
 * 2. 传入非法工具参数，确认错误返回模型且文件没有变化。
 * 3. 检查项目规则加载、复杂任务先读取文件并获得信息后才持久化和展示计划摘要、大输出限制，以及多项互不冲突的工具调用会在同一轮全部执行。
 * 4. 检查多文件调用的逐文件进度及结果持久化、新任务必须重新读文件，以及含凭据相关源码的工具结果仍是合法 JSON。
 * 5. 检查模型实际错误会进入任务失败记录和通知，对需要批准的命令确认保存的工具耗时只从真正执行开始计算，不包含审批等待；同时记录 SandboxBroker 的安全阶段和 trace。
 * 6. 配置辅助模型时，确认审批请求被路由给独立的低成本模型，并保存自动通过的分类决定。
 * 7. 新任务逐次捕获模型请求/响应和未截断工具结果，供后续导出隔离 replay case。
 *
 * 只模拟模型响应，文件操作、审批和保存使用实际实现。
 */

import { it, expect, vi } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { Engine } from "../src/agent/engine.js";
import { Store } from "../src/sessions/store.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { ModelError } from "../src/providers/model-error.js";
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

it("enforces step budget after saving removed-tool errors as tool results", async () => {
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

it("captures model exchanges and complete tool results for a replay case", async () => {
  let calls = 0;
  const fixture = await createFixture({
    async run() {
      if (++calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "replay-read",
              name: "read_file",
              arguments: JSON.stringify({
                path: "replay-target.txt",
                startLine: 1,
                endLine: 1,
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
    await writeFile(path.join(fixture.root, "replay-target.txt"), "original\n");
    fixture.engine.start(fixture.session.id, "read the target");
    await fixture.engine.active?.done;

    const task = fixture.store.tasks(fixture.session.id)[0];
    expect(fixture.store.replayCase(task.id)).toMatchObject({
      source: "captured",
      capture: {
        finalizedAt: expect.any(String),
        modelExchanges: [
          { purpose: "task", response: { text: "" } },
          { purpose: "task", response: { text: "done" } },
        ],
        tools: [
          {
            callId: "replay-read",
            arguments: { path: "replay-target.txt" },
            result: { text: "1: original" },
          },
        ],
      },
    });
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("creates independent files through one unified batch returned in one model response", async () => {
  let calls = 0;
  const fixture = await createFixture({
    async run() {
      if (++calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "create-files",
              name: "edit_files",
              arguments: JSON.stringify({
                files: [
                  {
                    path: "first.txt",
                    create: true,
                    content: "first file\n",
                  },
                  {
                    path: "second.txt",
                    create: true,
                    content: "second file\n",
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
    ).toHaveLength(1);
    expect(fixture.store.tasks(fixture.session.id)[0].status).toBe("completed");
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("persists a complex-task plan after inspection and before executing its next tool call", async () => {
  let calls = 0;
  const plan = "## 计划摘要\n1. 读取目标文件。\n2. 核对结果。";
  const fixture = await createFixture({
    async run() {
      if (++calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "read-plan-target",
              name: "read_file",
              arguments: JSON.stringify({
                path: "plan-target.txt",
                startLine: 1,
                endLine: 10,
              }),
            },
          ],
          text: "",
        };
      }

      if (calls === 2) {
        return {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: plan }],
            },
            {
              type: "function_call",
              call_id: "read-plan-verification",
              name: "read_file",
              arguments: JSON.stringify({
                path: "plan-target.txt",
                startLine: 1,
                endLine: 10,
              }),
            },
          ],
          text: plan,
        };
      }

      return done;
    },
  });

  try {
    await writeFile(path.join(fixture.root, "plan-target.txt"), "ready\n");
    fixture.engine.start(fixture.session.id, "请完成复杂任务");
    await fixture.engine.active?.done;

    const events = fixture.store.events(fixture.session.id);
    const inspectionResultIndex = events.findIndex(
      (event) =>
        event.type === "tool_result" &&
        event.data.callId === "read-plan-target",
    );
    const planIndex = events.findIndex(
      (event) => event.type === "assistant" && event.data.text === plan,
    );
    const verificationStartIndex = events.findIndex(
      (event) =>
        event.type === "tool_start" &&
        event.data.callId === "read-plan-verification",
    );

    expect(inspectionResultIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeGreaterThan(inspectionResultIndex);
    expect(verificationStartIndex).toBeGreaterThan(planIndex);
    expect(fixture.store.tasks(fixture.session.id)[0].status).toBe("completed");
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("starts tool duration after command approval instead of when the call is requested", async () => {
  let calls = 0;
  let now = 1_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const fixture = await createFixture({
    async run() {
      if (++calls === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "approved-command",
              name: "run_command",
              arguments: JSON.stringify({
                command: 'node -e "process.exit(0)"',
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
    const task = fixture.engine.start(fixture.session.id, "run the command");
    await expect.poll(() => fixture.engine.approvals.list()).toHaveLength(1);

    // 模拟用户在审批界面停留十秒；命令获准后时间才应开始累计。
    now += 10_000;
    fixture.engine.approvals.decide(
      fixture.engine.approvals.list()[0].id,
      "once",
    );
    await fixture.engine.active?.done;

    const events = fixture.store.events(fixture.session.id);
    const result = events.find((event) => event.type === "tool_result");
    const sandboxStages = events
      .filter((event) => event.type === "sandbox_stage")
      .map((event) => event.data.stage);
    const executionInstances = events
      .filter((event) => event.type === "execution_instance")
      .map((event) => event.data);
    const trace = await fixture.engine.savedTrace(task);
    const traceEvents = trace ? JSON.parse(trace).traceEvents : [];

    expect(result?.data.durationMs).toBe(0);
    expect(sandboxStages).toEqual([
      "policy_resolved",
      "executing",
      "collecting",
      "completed",
    ]);
    expect(executionInstances.map((record) => record.state)).toEqual([
      "created",
      "running",
      "completed",
    ]);
    expect(
      new Set(executionInstances.map((record) => record.executionInstanceId))
        .size,
    ).toBe(1);
    expect(executionInstances[1]).toMatchObject({
      mode: "host-process",
      pidKind: "host-process",
      sandboxRequested: false,
      sandboxApplied: false,
    });
    expect(executionInstances[1].pid).toBeGreaterThan(0);
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sandbox.policy_resolved", ph: "i" }),
        expect.objectContaining({ name: "sandbox.completed", ph: "i" }),
        expect.objectContaining({
          name: "sandbox.execution_instance.running",
          ph: "i",
        }),
      ]),
    );
  } finally {
    clock.mockRestore();
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("routes an approval to the configured low-cost model and persists an automatic pass", async () => {
  const root = await temp();
  const config = new Config(await temp());
  const store = new Store(path.join(config.directory, "db"));
  const session = store.create(root, "test");
  config.settings.auxiliaryModel = "approval-model";
  let taskCalls = 0;
  let approvalCalls = 0;
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    (settings, purpose) => {
      if (purpose === "approval") {
        return {
          async run(input, instructions, tools, _signal, _onDelta, options) {
            approvalCalls++;
            expect(settings.model).toBe("approval-model");
            expect(input[0].content).toContain("run_command");
            expect(instructions).toContain("工具审批分类器");
            expect(tools).toEqual([]);
            expect(options).toEqual({ maxOutputTokens: 256 });

            return {
              output: [],
              text: '{"decision":"approve","reason":"固定验证命令"}',
            };
          },
        };
      }

      return {
        async run() {
          if (++taskCalls === 1) {
            return {
              output: [
                {
                  type: "function_call",
                  call_id: "automatic-command",
                  name: "run_command",
                  arguments: JSON.stringify({
                    command: 'node -e "process.exit(0)"',
                  }),
                },
              ],
              text: "",
            };
          }

          return done;
        },
      };
    },
  );

  try {
    engine.start(session.id, "run a fixed command");
    await engine.active?.done;

    expect(approvalCalls).toBe(1);
    expect(engine.approvals.list()).toEqual([]);
    expect(store.events(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval_assessed",
          data: {
            tool: "run_command",
            decision: "approve",
            reason: "固定验证命令",
          },
        }),
      ]),
    );
  } finally {
    await engine.close();
    store.close();
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

it("persists the actual model error in the failed task and user notice", async () => {
  const fixture = await createFixture({
    async run() {
      throw new ModelError(
        "模型服务返回 HTTP 400。实际错误：该模型不支持 reasoning。",
        false,
        "http_400",
        400,
      );
    },
  });

  try {
    fixture.engine.start(fixture.session.id, "run the task");
    await fixture.engine.active?.done;

    expect(fixture.store.tasks(fixture.session.id)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("该模型不支持 reasoning"),
    });
    expect(
      fixture.store
        .events(fixture.session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            event.data.text.includes("该模型不支持 reasoning"),
        ),
    ).toBe(true);
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
              name: "edit_files",
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

it("loads project guidance, requires evidence-based complex-task plans, encourages independent batches, and bounds large tool feedback", async () => {
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
    expect(guidance).toContain("plan-and-execute workflow");
    expect(guidance).toContain("计划摘要");
    expect(guidance).toContain("Only after that initial investigation");
    expect(guidance).toContain(
      "do not produce a plan from assumptions before reading code or files",
    );
    expect(guidance).toContain(
      "Then immediately execute that evidence-based plan",
    );
    expect(guidance).toContain("multiple independent tool calls");
    expect(guidance).toContain("true DAG-parallel execution");
    expect(guidance).toContain("largest safe set of relevant tool calls");
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
                    create: false,
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
                  create: false,
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

it("lets the model create current-project memory without approval and exposes only a safe result", async () => {
  let calls = 0;
  let receivedResult: any;
  const fixture = await createFixture({
    async run(input, _instructions, tools) {
      if (++calls === 1) {
        expect(tools.map((tool) => tool.name)).toContain("memory_apply");

        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "remember-pnpm",
              name: "memory_apply",
              arguments: JSON.stringify({
                expectedVersion: null,
                operations: [
                  {
                    action: "create",
                    kind: "constraint",
                    title: "使用 pnpm",
                    statement: "项目使用 pnpm 运行验证命令。",
                    tags: ["pnpm"],
                    importance: "high",
                    confidence: "confirmed",
                    expiresAt: null,
                    source: {
                      summary: "当前任务已检查 package.json。",
                      eventId: null,
                      filePath: "package.json",
                      fileHash: "a".repeat(64),
                    },
                    reason: "稳定的项目约束。",
                  },
                ],
              }),
            },
          ],
        };
      }

      receivedResult = input
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output))
        .find((result) => result.operations);

      return done;
    },
  });

  try {
    fixture.engine.start(fixture.session.id, "记住包管理器约束");
    await fixture.engine.active?.done;

    expect(calls).toBe(2);
    expect(receivedResult).toMatchObject({
      version: expect.stringMatching(/^[a-f0-9]{64}$/),
      operations: [{ action: "create", id: expect.any(String) }],
    });
    const remembered = await fixture.engine.memories.retrieve(
      fixture.root,
      "pnpm 验证",
    );
    expect(remembered.bundle?.entries).toEqual([
      expect.objectContaining({ title: "使用 pnpm" }),
    ]);
    expect(
      fixture.store
        .events(fixture.session.id)
        .find(
          (event) =>
            event.type === "tool_start" && event.data.name === "memory_apply",
        )?.data.args,
    ).toEqual({ operationCount: 1 });
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});

it("executes a scheduled DAG and returns blocked descendants without invoking them", async () => {
  let calls = 0;
  let feedback: any[] = [];
  const fixture = await createFixture({
    async run(input) {
      if (++calls === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "missing-read",
              name: "read_file",
              arguments: JSON.stringify({
                execution: { id: "missing", dependsOn: [] },
                arguments: { path: "missing.txt", startLine: 1, endLine: 1 },
              }),
            },
            {
              type: "function_call",
              call_id: "blocked-read",
              name: "read_file",
              arguments: JSON.stringify({
                execution: { id: "dependent", dependsOn: ["missing"] },
                arguments: { path: "never-read.txt", startLine: 1, endLine: 1 },
              }),
            },
          ],
        };
      }

      feedback = input
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output));

      return done;
    },
  });

  try {
    fixture.engine.start(fixture.session.id, "exercise the tool graph");
    await fixture.engine.active?.done;

    expect(calls).toBe(2);
    expect(feedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ error: expect.any(String) }),
        expect.objectContaining({
          code: "dependency_failed",
          failedDependency: "missing",
        }),
      ]),
    );
    expect(
      fixture.store
        .events(fixture.session.id)
        .some((event) => event.type === "tool_batch_planned"),
    ).toBe(true);
  } finally {
    await fixture.engine.close();
    fixture.store.close();
  }
});
