/**
 * 候选 Runtime 适配器的实际子进程/IPC 回归，使用测试 stdio launcher，不提供 OS Sandbox 证明。
 * 1. launcher 声明模拟模式供协议测试；真实 AgentRuntimeService 执行临时目录命令，关闭由共享资源夹具兜底。
 * 2. 成功计划顺序执行，非零退出不运行后续命令；取消等待实际命令与 Runtime 停止后返回。
 * 3. 启动前 fallback 不执行宿主替代，注入清理失败返回 unknown；事件与 trace 归属当前实例。
 * WinFsp、安装态、账户权限由手动 --commands Sandbox 验证覆盖，不能由本文件的 mode 字段推导。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { expect, it } from "vitest";
import { temp } from "./fixtures/helpers.js";
import { currentTestResources } from "./fixtures/test-resources.js";
import { createRuntimeChildClose } from "./fixtures/runtime-child-close.js";
import {
  AgentRuntimeFallbackError,
  type AgentRuntimeLauncher,
} from "../src/sandbox/agent-runtime-launcher.js";
import { TraceRecorder } from "../src/tracing/recorder.js";
import { runCandidateCommands } from "../src/local-overlays/command-runtime.js";

async function fixture(orphaned = false) {
  const workspace = await temp();
  const traces = new TraceRecorder();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  traces.startTask(taskId, sessionId);
  const events: { type: string; data: any }[] = [];
  const reasons: string[] = [];
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
      child.stderr.resume();
      const close = createRuntimeChildClose(child);
      currentTestResources().defer(async () => {
        await close();
      });

      return {
        input: child.stdout,
        output: child.stdin,
        pid: child.pid!,
        mode: "windows-sandbox-user",
        close: async (reason) => {
          reasons.push(reason);
          const result = await close();

          return orphaned ? "orphaned" : result;
        },
      };
    },
  };

  return {
    workspace,
    traces,
    taskId,
    sessionId,
    launcher,
    log: pino({ enabled: false }),
    events,
    reasons,
    emit: async (type: string, data: unknown) => {
      events.push({ type, data });
    },
  };
}

it.each([0, 7])(
  "executes the fixed plan and stops after nonzero exit (%s)",
  async (code) => {
    const f = await fixture();
    const result = await runCandidateCommands({
      ...f,
      commands: [
        `node -e "require('fs').writeFileSync('first.txt','first')"; exit ${code}`,
        "node -e \"require('fs').writeFileSync('second.txt','second')\"",
      ],
      signal: AbortSignal.timeout(12_000),
    });
    expect(result).toEqual({
      drained: true,
      sandboxApplied: true,
      exitCode: code,
    });
    expect(await readFile(path.join(f.workspace, "first.txt"), "utf8")).toBe(
      "first",
    );
    if (code === 0) {
      expect(await readFile(path.join(f.workspace, "second.txt"), "utf8")).toBe(
        "second",
      );
    } else {
      await expect(
        readFile(path.join(f.workspace, "second.txt")),
      ).rejects.toThrow();
    }

    expect(f.reasons).toEqual(["completed"]);
    expect(
      f.events.filter(
        (event) =>
          event.type === "local_validation" &&
          event.data.event === "tool_result",
      ),
    ).toHaveLength(code === 0 ? 2 : 1);
  },
);

it("waits for a cancelled command and Runtime to stop", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const running = runCandidateCommands({
    ...f,
    commands: [
      "node -e \"require('fs').writeFileSync('started','yes');setTimeout(()=>require('fs').writeFileSync('late','bad'),30000)\"",
    ],
    signal: controller.signal,
  });
  const deadline = performance.now() + 10_000;
  while (
    !(await readFile(path.join(f.workspace, "started")).then(
      () => true,
      () => false,
    ))
  ) {
    expect(performance.now()).toBeLessThan(deadline);
    await delay(30);
  }

  controller.abort();
  expect(await running).toEqual({
    drained: true,
    sandboxApplied: true,
    exitCode: null,
  });
  expect(f.reasons).toEqual(["cancel"]);
  await expect(readFile(path.join(f.workspace, "late"))).rejects.toThrow();
});

it("refuses unconfirmed cleanup after completed commands", async () => {
  const f = await fixture(true);
  await expect(
    runCandidateCommands({
      ...f,
      commands: ["echo candidate"],
      signal: AbortSignal.timeout(12_000),
    }),
  ).rejects.toThrow("排空未确认");
  expect(
    f.events.some(
      (event) =>
        event.type === "execution_instance" && event.data.state === "unknown",
    ),
  ).toBe(true);
});

it("does not execute a host fallback when the launcher is unavailable", async () => {
  const f = await fixture();
  const result = await runCandidateCommands({
    ...f,
    launcher: {
      launch: async () => {
        throw new AgentRuntimeFallbackError();
      },
    },
    commands: ["echo must-not-run"],
    signal: new AbortController().signal,
  });
  expect(result).toEqual({
    drained: true,
    sandboxApplied: false,
    exitCode: null,
  });
  expect(f.events.some((event) => event.type === "local_validation")).toBe(
    false,
  );
});
