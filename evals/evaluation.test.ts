/**
 * 检查手动评测运行器是否复用生产工具，并按预算停止和导出记录。
 * 使用模拟模型和临时工作区，只由 pnpm eval:test 手动执行，不纳入默认检查。
 *
 * 1. 提供固定工具响应和 usage，检查实际文件读写及导出记录。
 * 2. 使用现行工具参数确认命令默认被拒绝，并分别检查有限预算与无额外预算模式。
 * 3. 检查 MeteredProvider 的主辅模型共享计量、未知用量和下一次请求前的预算检查。
 * 4. 检查重叠目录、非法预算和不符合授权范围的请求被拒绝。
 *
 * 只在用户要求时执行；这些用例验证运行器，不计算 SWE-bench 正确率。
 */

import { it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import {
  runEvaluation,
  approveEvaluationCommand,
} from "../src/evaluation/runner.js";
import { MeteredProvider } from "../src/evaluation/metered-provider.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import { temp } from "../tests/fixtures/helpers.js";

const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25 };
const final = { output: [], text: "done", usage };
const silent = pino({ enabled: false });

function tool(name: string, args: unknown, callId = name) {
  return {
    output: [
      {
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      },
    ],
    text: "",
    usage,
  };
}

it("runs production read/edit tools and exports independently verifiable artifacts", async () => {
  const workspace = await temp();
  const outputDir = await temp();
  await writeFile(
    path.join(workspace, "math.js"),
    "export const add = (a, b) => a - b;\n",
  );
  let calls = 0;
  const provider: ModelProvider = {
    async run(input) {
      calls++;
      if (calls === 1) {
        return tool("read_file", {
          path: "math.js",
          startLine: 1,
          endLine: 10,
        });
      }

      if (calls === 2) {
        expect(input.at(-1).output).toContain("a - b");

        return tool("edit_files", {
          files: [
            {
              path: "math.js",
              create: false,
              edits: [{ oldText: "a - b", newText: "a + b" }],
            },
          ],
        });
      }

      return final;
    },
  };

  const report = await runEvaluation(
    { workspace, outputDir, prompt: "Fix addition" },
    { provider, log: silent },
  );

  expect(report.task.status).toBe("completed");
  expect(report.verification).toBe("external");
  expect(report.usage).toMatchObject({
    calls: 3,
    totalTokens: 75,
    unmeasuredCalls: 0,
  });
  expect(await readFile(path.join(workspace, "math.js"), "utf8")).toContain(
    "a + b",
  );
  const saved = JSON.parse(
    await readFile(path.join(outputDir, "report.json"), "utf8"),
  );
  expect(saved.usage.totalTokens).toBe(75);
  const events = JSON.parse(
    await readFile(path.join(outputDir, "events.json"), "utf8"),
  );
  expect(events.some((event: any) => event.type === "diff")).toBe(true);
  await expect(
    runEvaluation(
      { workspace, outputDir, prompt: "again" },
      { provider, log: silent },
    ),
  ).rejects.toThrow();
});

it("denies commands by default without hanging or creating their side effects", async () => {
  const workspace = await temp();
  let calls = 0;
  const provider: ModelProvider = {
    async run(input) {
      if (calls++ === 0) {
        return tool("run_command", {
          command: `node -e "require('fs').writeFileSync('unexpected','x')"`,
        });
      }

      expect(input.at(-1).output).toContain("拒绝");

      return final;
    },
  };
  const report = await runEvaluation(
    { workspace, outputDir: await temp(), prompt: "test" },
    { provider, log: silent },
  );
  expect(report.approvals).toEqual({ allowed: 0, denied: 1 });
  await expect(readFile(path.join(workspace, "unexpected"))).rejects.toThrow();
});

it("stops before another model request once reported tokens reach the threshold", async () => {
  const workspace = await temp();
  await writeFile(path.join(workspace, "math.js"), "export const sum = 1;\n");
  const report = await runEvaluation(
    {
      workspace,
      outputDir: await temp(),
      prompt: "read",
      maxTotalTokens: 25,
    },
    {
      provider: {
        async run() {
          return tool("read_file", {
            path: "math.js",
            startLine: 1,
            endLine: 1,
          });
        },
      },
      log: silent,
    },
  );
  expect(report.task.status).toBe("failed");
  expect(report.stopReason).toBe("token_budget");
  expect(report.usage.calls).toBe(1);
});

it("cancels a blocked provider and records unknown usage on timeout", async () => {
  let providerStarted = false;

  const provider: ModelProvider = {
    async run(_input, _instructions, _tools, signal) {
      providerStarted = true;

      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  const report = await runEvaluation(
    {
      workspace: await temp(),
      outputDir: await temp(),
      prompt: "wait",
      // Allow initialization to reach the provider before the task timeout.
      timeoutMs: 1000,
    },
    { provider, log: silent },
  );
  expect(providerStarted).toBe(true);
  expect(report.task.status).toBe("cancelled");
  expect(report.stopReason).toBe("timeout");
  expect(report.usage.unmeasuredCalls).toBe(1);
});

it("counts summary calls and prevents further calls after missing usage", async () => {
  let calls = 0;
  const meter = new MeteredProvider(
    {
      async run() {
        calls++;

        return calls === 1 ? final : { output: [], text: "summary" };
      },
    },
    { maxTotalTokens: 1000, maxModelCalls: 10 },
    () => {},
  );
  const signal = new AbortController().signal;
  await meter.run([], "task", [], signal, () => {});
  await meter.run([], "summarize", [], signal, () => {});
  await expect(meter.run([], "again", [], signal, () => {})).rejects.toThrow(
    "usage_unavailable",
  );
  expect(meter.usage).toMatchObject({
    calls: 2,
    measuredCalls: 1,
    unmeasuredCalls: 1,
    totalTokens: 25,
  });
});

it("caps model calls even when total token usage is low", async () => {
  const meter = new MeteredProvider(
    {
      async run() {
        return final;
      },
    },
    { maxTotalTokens: 1000, maxModelCalls: 1 },
    () => {},
  );
  const signal = new AbortController().signal;
  await meter.run([], "task", [], signal, () => {});
  await expect(meter.run([], "again", [], signal, () => {})).rejects.toThrow(
    "call_budget",
  );
});

it("runs beyond the evaluation and product step defaults in unlimited mode", async () => {
  const workspace = await temp();
  const outputDir = await temp();
  await writeFile(path.join(workspace, "note.txt"), "note\n");
  let calls = 0;
  const provider: ModelProvider = {
    async run() {
      calls++;

      return calls <= 101
        ? tool(
            "read_file",
            { path: "note.txt", startLine: 1, endLine: 1 },
            `read-${calls}`,
          )
        : final;
    },
  };

  const report = await runEvaluation(
    { workspace, outputDir, prompt: "Read repeatedly", unlimited: true },
    { provider, log: silent },
  );

  expect(
    report.task.status,
    JSON.stringify({
      stopReason: report.stopReason,
      calls: report.usage.calls,
    }),
  ).toBe("completed");
  expect(report.usage.calls).toBe(102);
  expect(report.limits).toEqual({
    maxTotalTokens: null,
    maxModelCalls: null,
    maxSteps: null,
    timeoutMs: null,
  });
});

it("keeps measuring after a missing usage report in unlimited mode", async () => {
  let calls = 0;
  const meter = new MeteredProvider(
    {
      async run() {
        calls++;

        return calls === 1 ? { output: [], text: "unmetered" } : final;
      },
    },
    { maxTotalTokens: 1, maxModelCalls: 1, unlimited: true },
    () => {},
  );
  const signal = new AbortController().signal;
  await meter.run([], "task", [], signal, () => {});
  await meter.run([], "task", [], signal, () => {});
  await meter.run([], "task", [], signal, () => {});

  expect(meter.usage).toMatchObject({
    calls: 3,
    measuredCalls: 2,
    unmeasuredCalls: 1,
    totalTokens: 50,
  });
});

it("does not apply the evaluation task timer in unlimited mode", async () => {
  const report = await runEvaluation(
    {
      workspace: await temp(),
      outputDir: await temp(),
      prompt: "wait and finish",
      timeoutMs: 100,
      unlimited: true,
    },
    {
      provider: {
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 200));

          return final;
        },
      },
      log: silent,
    },
  );

  expect(report.task.status).toBe("completed");
  expect(report.limits.timeoutMs).toBeNull();
});

it("allows the production run_command approval shape only in the workspace", () => {
  const root = path.resolve("workspace");
  const approval = {
    id: "a",
    sessionId: "s",
    taskId: "t",
    repeatable: false,
    tool: "run_command",
    description: JSON.stringify({
      command: "pwd; find . -maxdepth 2 -name AGENTS.md -print",
      cwd: root,
    }),
  };
  expect(approveEvaluationCommand(approval, root)).toBe(true);
  expect(
    approveEvaluationCommand({ ...approval, tool: "file_write" }, root),
  ).toBe(false);
  expect(
    approveEvaluationCommand({ ...approval, description: "broken" }, root),
  ).toBe(false);
  expect(
    approveEvaluationCommand(
      {
        ...approval,
        description: JSON.stringify({
          command: "node",
          cwd: root + "-outside",
        }),
      },
      root,
    ),
  ).toBe(false);
  expect(
    approveEvaluationCommand(
      {
        ...approval,
        description: JSON.stringify({ command: "node" }),
      },
      root,
    ),
  ).toBe(false);
});

it("rejects overlapping artifact paths and invalid budgets", async () => {
  const root = await temp();
  await expect(
    runEvaluation({ workspace: root, outputDir: root, prompt: "test" }),
  ).rejects.toThrow("separate");
  await expect(
    runEvaluation({
      workspace: root,
      outputDir: root,
      prompt: "test",
      maxTotalTokens: -1,
    }),
  ).rejects.toThrow();
});

it.runIf(process.platform !== "linux")(
  "refuses automatic approvals on the host",
  async () => {
    await expect(
      runEvaluation({
        workspace: await temp(),
        outputDir: await temp(),
        prompt: "test",
        allowWorkspaceCommands: true,
      }),
    ).rejects.toThrow("Docker");
  },
);

it("shares call and token accounting across auxiliary provider views", async () => {
  const meter = new MeteredProvider(
    {
      async run() {
        return final;
      },
    },
    { maxTotalTokens: 1000, maxModelCalls: 2 },
    () => {},
  );
  const auxiliary = meter.forProvider({
    async run() {
      return { ...final, text: "summary" };
    },
  });
  const signal = new AbortController().signal;
  await meter.run([], "task", [], signal, () => {});
  const result = await auxiliary.run([], "summary", [], signal, () => {});
  expect(result.text).toBe("summary");
  expect(meter.usage).toMatchObject({
    calls: 2,
    measuredCalls: 2,
    totalTokens: 50,
    unmeasuredCalls: 0,
  });
  await expect(meter.run([], "task", [], signal, () => {})).rejects.toThrow(
    "call_budget",
  );
  expect(meter.usage.calls).toBe(2);
});
