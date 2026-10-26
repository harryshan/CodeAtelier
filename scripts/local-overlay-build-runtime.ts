/**
 * 工程手动验证的真实 Sandbox 适配器，由 verify-local-overlay-build.ts 按 --sandbox 调用。
 * 1. 使用生产配置解析、Native Runtime、Broker 和固定候选命令计划，不替换 ACL/IPC/进程回执。
 * 2. Node 来自已安装受保护 Runtime；编译器和项目参数由调用方固定在候选视图内，不增加来源根。
 * 3. 保存真实执行事件/输出与 trace，返回命令退出及排空事实；失败不转宿主、不安装或 Repair。
 * 4. 正常终态核对专用账户模式与零活动租约，未知结果向外传播供 CandidateValidator 保留现场。
 * 无模型 API 或真实配置文件依赖；底层首次自检沿用生产账户恢复，应在没有其它 Sandbox 任务时运行。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "../src/logging/logger.js";
import { runCandidateCommands } from "../src/local-overlays/command-runtime.js";
import { SandboxBroker } from "../src/sandbox/broker.js";
import { sandboxConfiguration } from "../src/sandbox/config.js";
import { createSandboxRuntime } from "../src/sandbox/runtime-factory.js";
import { TraceArchive } from "../src/tracing/archive.js";
import { TraceRecorder } from "../src/tracing/recorder.js";

export async function runBuildInSandbox(
  root: string,
  workspace: string,
  compilerArguments: string[],
  signal: AbortSignal,
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEATELIER_SANDBOX_ENABLED: "true",
  };
  const configuration = sandboxConfiguration(environment);
  const log = createLogger(root, "info");
  const traces = new TraceRecorder();
  const sessionId = randomUUID();
  const taskId = randomUUID();
  traces.startTask(taskId, sessionId);
  const runtime = createSandboxRuntime(
    configuration,
    process.platform,
    log,
    traces,
    root,
    environment,
  );
  const broker = new SandboxBroker(configuration, runtime, log, traces);
  assert(
    environment.CODEATELIER_SANDBOX_STATE_PATH || environment.ProgramData,
    "Sandbox installation location unavailable",
  );
  const state =
    environment.CODEATELIER_SANDBOX_STATE_PATH ??
    path.join(
      environment.ProgramData!,
      "CodeAtelier",
      "Sandbox",
      "installation.state",
    );
  const node = path.join(path.dirname(state), "runtime", "node.exe");
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "whoami",
    "if (Test-Path -LiteralPath '.git') { throw 'Git metadata visible' }",
    `& ${quote(node)} '.\\node_modules\\typescript\\lib\\tsc.js' ${compilerArguments.map(quote).join(" ")}`,
    "exit $LASTEXITCODE",
  ].join("; ");
  const events: { type: string; data: unknown }[] = [];
  let outcome: "ok" | "error" | "unknown" = "unknown";
  const start = performance.now();
  try {
    const execution = await runCandidateCommands({
      launcher: broker,
      traces,
      log,
      sessionId,
      taskId,
      workspace,
      commands: [command],
      signal,
      emit: async (type, data) => {
        events.push({ type, data });
      },
    });
    const elapsedMs = performance.now() - start;
    const tools = events.flatMap((event) => {
      if (event.type !== "local_validation") {
        return [];
      }

      const value = z
        .object({ event: z.string(), data: z.unknown() })
        .parse(event.data);
      if (value.event !== "tool_result") {
        return [];
      }

      return [
        z
          .object({
            result: z
              .object({
                output: z.string().optional(),
                truncated: z.boolean().optional(),
              })
              .passthrough(),
          })
          .parse(value.data).result,
      ];
    });
    const terminal = events
      .filter((event) => event.type === "execution_instance")
      .map((event) =>
        z
          .object({
            mode: z.string(),
            state: z.string(),
            sandboxApplied: z.boolean(),
          })
          .parse(event.data),
      )
      .at(-1);
    assert(
      terminal?.mode === "windows-sandbox-user" && terminal.sandboxApplied,
      "No installed Sandbox execution proof",
    );
    assert(
      ["completed", "failed", "cancelled"].includes(terminal.state),
      "Runtime termination unknown",
    );
    assert.equal(broker.accountGenerationSnapshot()?.activeInstanceCount, 0);
    assert.equal(tools.length, 1);
    assert.notEqual(tools[0]!.truncated, true, "Compiler output was truncated");
    outcome = execution.exitCode === 0 ? "ok" : "error";

    return { execution, elapsedMs, output: tools[0]!.output ?? "", terminal };
  } finally {
    broker.releaseTask(taskId);
    traces.finishTask(taskId, outcome);
    await new TraceArchive(root, log).write(
      sessionId,
      taskId,
      traces.exportTask(taskId),
    );
    traces.discardTask(taskId);
    await writeFile(
      path.join(root, "sandbox-events.json"),
      JSON.stringify(events, null, 2) + "\n",
    );
  }
}
