/**
 * 文件作用：验证手动 Evaluation 适配器的生产工具复用和预算边界。
 *
 * 使用场景与输入输出：
 * 独立 eval:test 入口的适配器回归，使用模拟模型与临时工作区，不属于默认 pnpm test/check。
 *
 * 代码结构与阅读顺序：
 * 1. 先定义固定 usage 和工具响应，验证生产读写工具及导出记录可独立检查。
 * 2. 命令默认拒绝且无副作用，token、调用次数及超时分别触发停止。
 * 3. MeteredProvider 场景覆盖摘要计量、缺失 usage 和下一次调用阻断。
 * 4. 目录重叠、非法预算与审批作用域验证在运行前或审批时拒绝。
 *
 * 维护注意事项：
 * 仅用户明确要求时执行该套件；它验证适配器边界，不给出 SWE-bench 任务正确率。
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

function tool(name: string, args: unknown) {
  return {
    output: [
      {
        type: "function_call",
        call_id: name,
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

        return tool("edit_file", {
          path: "math.js",
          oldText: "a - b",
          newText: "a + b",
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
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('unexpected','x')"],
          cwd: ".",
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
  const report = await runEvaluation(
    {
      workspace: await temp(),
      outputDir: await temp(),
      prompt: "list",
      maxTotalTokens: 25,
    },
    {
      provider: {
        async run() {
          return tool("list_files", { path: "." });
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
  const provider: ModelProvider = {
    async run(_input, _instructions, _tools, signal) {
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
      timeoutMs: 100,
    },
    { provider, log: silent },
  );
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

it("allows only command approvals rooted in the workspace", () => {
  const root = path.resolve("workspace");
  const approval = {
    id: "a",
    sessionId: "s",
    taskId: "t",
    repeatable: false,
    tool: "run_command",
    description: JSON.stringify({
      command: "node",
      args: ["--test"],
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
          args: [],
          cwd: root + "-outside",
        }),
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
