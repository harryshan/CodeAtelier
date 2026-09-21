/**
 * 在已安装的 Windows Sandbox 上运行真实 Agent Runtime 产品链路验收，而不是只检查安装文件和账户状态。
 * 本脚本由用户显式执行，不属于 pnpm test/check，也不调用真实模型、网络、凭据、Git remote 或管理员安装操作。
 *
 * 1. 在仓库 .local 下建立一次性工作区和 Broker 数据库，并强制启用 Windows Sandbox 产品组装。
 * 2. 用内存模型驱动固定 Agent Runtime 创建标记文件，核对 agent loop、Runtime IPC、文件工具与 clean grant release。
 * 3. 再让模型请求保持进行中并主动取消任务，核对 Job 终止、cancelled 归因和 generation lease 清空。
 * 4. 只有两条链路均为 windows-sandbox-user 且没有 fallback/unknown 才输出 PASS；失败现场保留供人工对账。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { Engine } from "../../src/agent/engine.js";
import { Config } from "../../src/config/config.js";
import type { ModelProvider } from "../../src/providers/model-provider.js";
import { Store } from "../../src/sessions/store.js";

const verificationTimeoutMs = 60_000;
const markerName = "agent-runtime-marker.txt";
const markerContent = "written-by-installed-agent-runtime\n";

function fail(message: string): never {
  throw new Error(`SANDBOX_AGENT_RUNTIME_VERIFY FAIL ${message}`);
}

function executionEvents(store: Store, sessionId: string) {
  return store
    .events(sessionId)
    .filter((event) => event.type === "execution_instance")
    .map((event) => event.data as Record<string, unknown>);
}

function assertCompletedRuntime(store: Store, sessionId: string) {
  const events = store.events(sessionId);
  const completed = executionEvents(store, sessionId).some(
    (event) =>
      event.kind === "agent-runtime" &&
      event.mode === "windows-sandbox-user" &&
      event.state === "completed" &&
      event.sandboxApplied === true &&
      event.pidKind === "runtime" &&
      typeof event.pid === "number",
  );
  if (
    !completed ||
    events.some(
      (event) =>
        event.type === "sandbox_warning" || event.type === "sandbox_fallback",
    )
  ) {
    fail("completed task did not remain inside the installed Runtime");
  }
}

function assertCancelledRuntime(store: Store, sessionId: string) {
  const events = executionEvents(store, sessionId);
  if (
    !events.some(
      (event) =>
        event.kind === "agent-runtime" &&
        event.mode === "windows-sandbox-user" &&
        event.state === "cancelled" &&
        event.sandboxApplied === true,
    ) ||
    events.some((event) => event.state === "unknown")
  ) {
    fail("cancelled task did not prove clean Runtime shutdown");
  }
}

function completedProvider(): ModelProvider {
  let calls = 0;

  return {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 32_000,
          max_output_tokens: 1_024,
        },
      };
    },
    async run(input) {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              call_id: "runtime-create-marker",
              name: "edit_files",
              arguments: JSON.stringify({
                files: [
                  {
                    path: markerName,
                    create: true,
                    content: markerContent,
                  },
                ],
              }),
            },
          ],
        };
      }

      if (!JSON.stringify(input).includes("runtime-create-marker")) {
        fail("Runtime tool result did not return through Broker model adapter");
      }

      return { text: "verification complete", output: [] };
    },
  };
}

function cancelledProvider(entered: () => void): ModelProvider {
  return {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 32_000,
          max_output_tokens: 1_024,
        },
      };
    },
    async run(_input, _instructions, _tools, signal) {
      entered();

      return new Promise((_resolve, reject) => {
        const aborted = () =>
          reject(signal.reason ?? new Error("verification task cancelled"));
        signal.addEventListener("abort", aborted, { once: true });
      });
    },
  };
}

async function waitFor(signal: Promise<void>, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          verificationTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function main() {
  if (process.platform !== "win32") {
    process.stdout.write(
      `SANDBOX_AGENT_RUNTIME_VERIFY SKIP platform=${process.platform}\n`,
    );

    return;
  }

  process.env.CODEATELIER_SANDBOX_ENABLED = "true";
  process.env.CODEATELIER_BASE_URL ||= "http://127.0.0.1:1/v1";
  process.env.CODEATELIER_MODEL ||= "sandbox-verification-model";
  process.env.CODEATELIER_API_KEY = "";

  const root = path.resolve(
    ".local",
    "sandbox-runtime-verification",
    randomUUID(),
  );
  const workspace = path.join(root, "workspace");
  const dataDirectory = path.join(root, "broker-data");
  await mkdir(workspace, { recursive: true });

  const config = new Config(dataDirectory);
  config.settings.maxSteps = 4;
  config.settings.commandTimeoutMs = 20_000;
  const store = new Store(path.join(dataDirectory, "history.sqlite"));
  let passed = false;
  let engine: Engine | undefined;
  try {
    const completedSession = store.create(
      workspace,
      "Runtime completion probe",
    );
    const completionModel = completedProvider();
    engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      () => completionModel,
    );
    const completedTask = engine.start(
      completedSession.id,
      "Create the fixed verification marker.",
    );
    await waitFor(engine.active!.done, "completed Runtime task");
    if (store.task(completedTask.id)?.status !== "completed") {
      fail("fixed tool task did not complete");
    }

    if (
      (await readFile(path.join(workspace, markerName), "utf8")) !==
      markerContent
    ) {
      fail("Runtime did not create the expected marker");
    }

    assertCompletedRuntime(store, completedSession.id);
    if (engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount !== 0) {
      fail("completed Runtime left an active generation lease");
    }

    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    await engine.close();
    engine = undefined;
    const cancellationModel = cancelledProvider(resolveEntered);
    engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      () => cancellationModel,
    );
    const cancelledSession = store.create(workspace, "Runtime cancel probe");
    const cancelledTask = engine.start(
      cancelledSession.id,
      "Wait until the Broker cancels this verification task.",
    );
    const cancelDone = engine.active!.done;
    await waitFor(entered, "Runtime model request");
    engine.cancel(cancelledTask.id);
    await waitFor(cancelDone, "cancelled Runtime task");
    if (store.task(cancelledTask.id)?.status !== "cancelled") {
      fail("task cancellation did not persist cancelled");
    }

    assertCancelledRuntime(store, cancelledSession.id);
    if (engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount !== 0) {
      fail("cancelled Runtime left an active generation lease");
    }

    passed = true;
    process.stdout.write(
      "SANDBOX_AGENT_RUNTIME_VERIFY PASS completion=yes cancellation=yes cleanup=yes\n",
    );
  } finally {
    await engine?.close().catch(() => undefined);
    store.close();
    if (passed) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stderr.write(
        "SANDBOX_AGENT_RUNTIME_VERIFY retained failure workspace under .local/sandbox-runtime-verification\n",
      );
    }
  }
}

await main();
