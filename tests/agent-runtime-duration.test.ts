/**
 * 检查 Broker 将 Runtime 执行片段的耗时持久化到工具结果，不依赖真实模型或 Windows 安装态。
 * 1. 测试 launcher 使用真实 Node Runtime 子进程和 stdio IPC，数据库与模型夹具留在 Broker。
 * 2. 模型先返回无效图，再触发二进制读取失败及依赖阻断，检查执行与未执行结果的耗时区别。
 * 3. 将结果与导出的执行 trace 比较，再重开 Store 验证耗时不是仅在内存或 UI 中补齐。
 * 临时目录和子进程在 finally 中清理；不重放工具，不改变审批或 Sandbox 权限。
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { Engine } from "../src/agent/engine.js";
import { Config } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/model-provider.js";
import type { AgentRuntimeLauncher } from "../src/sandbox/agent-runtime-launcher.js";
import { Store } from "../src/sessions/store.js";
import { temp } from "./fixtures/helpers.js";

it("persists execution duration for failures and zero for invalid or blocked calls", async () => {
  const root = await temp();
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const config = new Config(await temp());
  config.sandbox.enabled = true;
  const database = path.join(config.directory, "db");
  const store = new Store(database);
  const session = store.create(root, "Runtime duration");
  const errors: Buffer[] = [];
  const launcher: AgentRuntimeLauncher = {
    async launch(input) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("tests/fixtures/agent-runtime-service-child.ts"),
        ],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            CODEATELIER_TEST_RUNTIME_DESCRIPTOR: JSON.stringify({
              identity: input.identity,
              nonce: input.nonce,
            }),
          },
        },
      );
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      const exited = new Promise<"clean" | "orphaned">((resolve) => {
        child.once("exit", (code) =>
          resolve(code === 0 ? "clean" : "orphaned"),
        );
      });

      return {
        input: child.stdout,
        output: child.stdin,
        pid: child.pid!,
        close: async () => {
          child.stdin.end();

          return exited;
        },
      };
    },
  };
  let modelCalls = 0;
  const provider: ModelProvider = {
    async run() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "invalid",
              name: "read_file",
              arguments: "{",
            },
          ],
        };
      }

      if (modelCalls === 2) {
        return {
          text: "",
          output: ["binary", "blocked"].map((id) => ({
            type: "function_call" as const,
            call_id: id,
            name: "read_file",
            arguments: JSON.stringify({
              execution: { id, dependsOn: id === "blocked" ? ["binary"] : [] },
              arguments: { path: "binary.bin", startLine: 1, endLine: 1 },
            }),
          })),
        };
      }

      return { text: "done", output: [] };
    },
  };
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => provider,
    launcher,
  );
  let savedResults: unknown[] = [];

  try {
    const task = engine.start(session.id, "check tool durations");
    await engine.active?.done;
    expect(store.task(task.id)?.status, store.task(task.id)?.error).toBe(
      "completed",
    );
    const results = store
      .events(session.id)
      .filter((event) => event.type === "tool_result");
    expect(results).toHaveLength(3);
    const byCall = new Map(
      results.map((event) => [event.data.callId, event.data]),
    );
    expect(byCall.get("invalid")).toMatchObject({
      durationMs: 0,
      result: { error: expect.any(String) },
    });
    expect(byCall.get("blocked")).toMatchObject({
      durationMs: 0,
      result: { code: "dependency_failed" },
    });
    expect(byCall.get("binary")?.result.error).toEqual(expect.any(String));

    const trace = JSON.parse((await engine.savedTrace(task))!);
    const starts = trace.traceEvents.filter(
      (event: any) => event.name === "tool.read_file" && event.ph === "B",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toMatchObject({ callId: "binary", status: "error" });
    const end = trace.traceEvents.find(
      (event: any) =>
        event.name === "tool.read_file" &&
        event.ph === "E" &&
        event.tid === starts[0].tid,
    );
    expect(byCall.get("binary")?.durationMs).toBe(
      Math.round((end.ts - starts[0].ts) / 1000),
    );
    savedResults = results.map((event) => event.data);
    expect(Buffer.concat(errors).toString("utf8")).toBe("");
  } finally {
    await engine.close();
    store.close();
  }

  const reopened = new Store(database);
  try {
    expect(
      reopened
        .events(session.id)
        .filter((event) => event.type === "tool_result")
        .map((event) => event.data),
    ).toEqual(savedResults);
  } finally {
    reopened.close();
  }
});
