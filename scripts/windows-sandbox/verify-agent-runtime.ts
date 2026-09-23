/**
 * 在已安装的 Windows Sandbox 上运行真实 Agent Runtime 产品链路验收，而不是只检查安装文件和账户状态。
 * 本脚本由用户显式执行，不属于 pnpm test/check，也不调用真实模型、外部网络、真实凭据或管理员安装操作。
 *
 * 1. 在仓库 .local 下建立一次性工作区和 Broker 数据库，并强制启用 Windows Sandbox 产品组装。
 * 2. 内存模型驱动固定 Agent Runtime 创建标记文件，再以内部已标记任务让安装态独立 Worker 只读该文件，核对规划、模型 IPC、报告原子收集、tracing 和退出后的租约。
 * 3. 请求 sibling 目录写权限，经低成本模型审批后用独立 Capability Runner 写入标记，核对结果回传、外部 ACL 和 clean release。
 * 4. 初始化一次性 Git 仓库，把 HTTPS remote 指向 relay 必须拒绝的 127.0.0.1；验证 Runtime 阻塞等待独立 Push Runner、审批、失败结果回传和 clean lease release，全程不连接公网。
 * 5. 再让模型请求保持进行中并主动取消任务，核对 Job 终止、cancelled 归因和 generation lease 清空。
 * 6. 只有五条链路均为 windows-sandbox-user 且没有 fallback/unknown 才输出 PASS；失败现场保留供人工对账。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { Engine } from "../../src/agent/engine.js";
import { Config } from "../../src/config/config.js";
import type { ModelProvider } from "../../src/providers/model-provider.js";
import { Store } from "../../src/sessions/store.js";
import { commandShell } from "../../src/tools/command-shell.js";

const verificationTimeoutMs = 60_000;
const markerName = "agent-runtime-marker.txt";
const markerContent = "written-by-installed-agent-runtime\n";
const capabilityMarkerName = "capability-runner-marker.txt";
const capabilityMarkerContent = "written-by-capability-runner";
const blockedRemote = "https://127.0.0.1/codeatelier-verification.git";
const runFile = promisify(execFile);

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

function assertBlockedPushRunner(store: Store, sessionId: string) {
  const events = store.events(sessionId);
  const executions = executionEvents(store, sessionId);
  const pushStates = executions
    .filter((event) => event.kind === "push-runner")
    .map((event) => event.state);
  if (
    !pushStates.includes("running") ||
    !pushStates.includes("failed") ||
    pushStates.includes("unknown") ||
    executions.some(
      (event) =>
        event.kind === "push-runner" &&
        event.toolCallId !== "runtime-blocked-push",
    ) ||
    !executions.some(
      (event) =>
        event.kind === "agent-runtime" &&
        event.mode === "windows-sandbox-user" &&
        event.state === "completed",
    ) ||
    !events.some(
      (event) =>
        event.type === "approval_assessed" &&
        (event.data as Record<string, unknown>).tool === "git_push" &&
        (event.data as Record<string, unknown>).decision === "approve",
    ) ||
    events.some(
      (event) =>
        event.type === "sandbox_warning" || event.type === "sandbox_fallback",
    )
  ) {
    fail("blocked push did not use one clean independent Push Runner");
  }
}

function assertCapabilityRunner(store: Store, sessionId: string) {
  const events = store.events(sessionId);
  const executions = executionEvents(store, sessionId);
  const capabilityStates = executions
    .filter((event) => event.kind === "capability-runner")
    .map((event) => event.state);
  if (
    !capabilityStates.includes("running") ||
    !capabilityStates.includes("failed") ||
    capabilityStates.includes("unknown") ||
    executions.some(
      (event) =>
        event.kind === "capability-runner" &&
        event.toolCallId !== "runtime-capability-write",
    ) ||
    !executions.some(
      (event) =>
        event.kind === "agent-runtime" &&
        event.mode === "windows-sandbox-user" &&
        event.state === "completed",
    ) ||
    !events.some(
      (event) =>
        event.type === "approval_assessed" &&
        (event.data as Record<string, unknown>).tool ===
          "run_with_permissions" &&
        (event.data as Record<string, unknown>).decision === "approve",
    ) ||
    events.some(
      (event) =>
        event.type === "sandbox_warning" || event.type === "sandbox_fallback",
    )
  ) {
    fail("expanded write did not use one clean independent Capability Runner");
  }
}

async function initializeGitFixture(workspace: string) {
  await writeFile(path.join(workspace, "seed.txt"), "sandbox push fixture\n");
  const git = async (...args: string[]) => {
    await runFile("git", args, { cwd: workspace, windowsHide: true });
  };

  await git("init", "-b", "main");
  await git("config", "user.name", "CodeAtelier Sandbox Verification");
  await git("config", "user.email", "sandbox-verification@example.invalid");
  await git("add", "seed.txt");
  await git("commit", "-m", "sandbox push fixture");
  await git("remote", "add", "origin", blockedRemote);
  await git("config", "branch.main.remote", "origin");
  await git("config", "branch.main.merge", "refs/heads/main");
}

function completedProvider(): ModelProvider {
  let calls = 0;

  return {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 64_000,
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

function subagentProvider() {
  let mainCalls = 0;
  let childCalls = 0;
  const action = (id: string, request: unknown) => ({
    type: "function_call" as const,
    call_id: id,
    name: "subagent",
    arguments: JSON.stringify({
      execution: { id, dependsOn: [] },
      arguments: { request },
    }),
  });
  const provider: ModelProvider = {
    async getCapabilities() {
      return {
        limits: { max_context_window_tokens: 64_000, max_output_tokens: 1_024 },
      };
    },
    async run(input, instructions, tools) {
      if (instructions.includes("read-only research subagent")) {
        childCalls++;
        if (
          tools.map((tool) => tool.name).join(",") !==
          "read_file,list_entries,search_text,ask_main"
        ) {
          fail("installed subagent received a write-capable tool definition");
        }

        if (childCalls === 1) {
          return {
            text: "",
            output: [
              {
                type: "function_call",
                call_id: "verify-read",
                name: "read_file",
                arguments: JSON.stringify({
                  execution: { id: "read", dependsOn: [] },
                  arguments: { path: markerName, startLine: 1, endLine: 1 },
                }),
              },
            ],
          };
        }

        if (!JSON.stringify(input).includes(markerContent.trim())) {
          fail("subagent did not receive the installed Runtime read result");
        }

        return { text: `${markerName}:1 ${markerContent.trim()}`, output: [] };
      }

      mainCalls++;
      if (!tools.some((tool) => tool.name === "subagent")) {
        fail("installed Runtime did not receive the opt-in coordination tool");
      }

      if (mainCalls === 1) {
        return {
          text: "",
          output: [
            action("plan", {
              action: "plan",
              subtasks: [
                {
                  id: "read-verifier",
                  role: "reader",
                  objective: "inspect the fixed marker",
                  scope: ["."],
                  dependsOn: [],
                  deliverable: "source path and line",
                },
              ],
            }),
          ],
        };
      }

      if (mainCalls === 2) {
        return {
          text: "",
          output: [
            action("await", {
              action: "await",
              subagentIds: ["read-verifier"],
              timeoutMs: 30_000,
            }),
          ],
        };
      }

      if (mainCalls === 3) {
        return {
          text: "",
          output: [
            action("collect", {
              action: "collect",
              subagentIds: ["read-verifier"],
            }),
          ],
        };
      }

      if (
        mainCalls !== 4 ||
        !JSON.stringify(input).includes(`${markerName}:1`)
      ) {
        fail(
          "main Runtime did not receive the subagent report through collect",
        );
      }

      return { text: "installed subagent verification complete", output: [] };
    },
  };

  return { provider, counts: () => ({ mainCalls, childCalls }) };
}

function cancelledProvider(entered: () => void): ModelProvider {
  return {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 64_000,
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

function approvalProvider(): ModelProvider {
  return {
    async run() {
      return {
        text: JSON.stringify({
          decision: "approve",
          reason: "固定安装态 Sandbox Runner 验证。",
        }),
        output: [],
      };
    },
  };
}

function capabilityProvider(
  externalDirectory: string,
  command: string,
): ModelProvider {
  let calls = 0;

  return {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 64_000,
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
              call_id: "runtime-capability-write",
              name: "run_with_permissions",
              arguments: JSON.stringify({
                command,
                permissions: {
                  readRoots: [],
                  writeRoots: [externalDirectory],
                  httpsHost: "127.0.0.1",
                },
                reason:
                  "验证已安装 Capability Runner 的工作区外写入和认证 HTTPS relay 私网拒绝边界。",
              }),
            },
          ],
        };
      }

      const serialized = JSON.stringify(input);
      if (
        !serialized.includes("runtime-capability-write") ||
        !serialized.includes("403") ||
        serialized.includes('"exitCode":0')
      ) {
        fail("Capability Runner result did not return to Agent Runtime");
      }

      return { text: "capability verification complete", output: [] };
    },
  };
}

function capabilityProbeCommand(markerPath: string) {
  const shell = commandShell(process.env, undefined, process.platform, false);
  if (!shell) {
    fail("no command shell is available for the Capability Runner probe");
  }

  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const curl = path.join(windowsRoot, "System32", "curl.exe");
  const curlArguments =
    '--fail --silent --show-error --connect-timeout 5 --max-time 10 "https://127.0.0.1/"';
  if (path.basename(shell.command).toLocaleLowerCase() === "cmd.exe") {
    return `echo ${capabilityMarkerContent} > "${markerPath}" & "${curl}" ${curlArguments}`;
  }

  const quotedMarker = markerPath.replaceAll("'", "''");
  const quotedCurl = curl.replaceAll("'", "''");

  return `Set-Content -LiteralPath '${quotedMarker}' -Value '${capabilityMarkerContent}' -NoNewline; & '${quotedCurl}' ${curlArguments}`;
}

function blockedPushProvider(): ModelProvider {
  let calls = 0;

  return {
    async getCapabilities() {
      return {
        limits: {
          max_context_window_tokens: 64_000,
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
              call_id: "runtime-blocked-push",
              name: "git",
              arguments: JSON.stringify({ request: { action: "push" } }),
            },
          ],
        };
      }

      const serialized = JSON.stringify(input);
      if (
        !serialized.includes("runtime-blocked-push") ||
        !serialized.includes('"exitCode"')
      ) {
        fail("Push Runner result did not return to the blocked Agent Runtime");
      }

      return { text: "blocked push verification complete", output: [] };
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

async function verifyInstalledSubagent(
  store: Store,
  config: Config,
  workspace: string,
) {
  const session = store.create(workspace, "Installed Runtime subagent probe");
  // 发布门禁尚未打开：仅手动产品验收可以通过内部队列启动已标记任务，HTTP 仍必须拒绝启用。
  const task = store.transaction(() => {
    const created = store.createTask(session.id, true);
    store.event(session.id, created.id, "user", {
      text: "Inspect the installed marker with a read-only subagent.",
    });

    return created;
  });
  const markerBefore = await readFile(path.join(workspace, markerName), "utf8");
  const model = subagentProvider();
  const engine = new Engine(
    store,
    config,
    pino({ enabled: false }),
    () => model.provider,
  );

  try {
    (engine as unknown as { schedule(): void }).schedule();
    const pending = engine.active?.done;
    if (!pending) {
      fail("opted-in verification task was not scheduled");
    }

    await waitFor(pending, "installed Runtime subagent task");
    if (store.task(task.id)?.status !== "completed") {
      fail("opted-in Runtime subagent task did not complete");
    }

    const agents = store.subagents(task.id);
    if (
      agents.length !== 1 ||
      agents[0].status !== "completed" ||
      agents[0].consumed !== true ||
      agents[0].report !== `${markerName}:1 ${markerContent.trim()}` ||
      model.counts().mainCalls !== 4 ||
      model.counts().childCalls !== 2
    ) {
      fail(
        "installed subagent report or model round accounting did not persist",
      );
    }

    if (
      (await readFile(path.join(workspace, markerName), "utf8")) !==
      markerBefore
    ) {
      fail("read-only subagent changed the workspace marker");
    }

    const trace = await engine.savedTrace(task);
    if (
      !trace?.includes("subagent.worker") ||
      trace.includes(markerContent.trim())
    ) {
      fail("installed subagent trace is missing or contains source text");
    }

    assertCompletedRuntime(store, session.id);
    if (engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount !== 0) {
      fail("installed subagent left an active generation lease");
    }
  } finally {
    await engine.close();
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
  const externalDirectory = path.join(root, "external-write");
  const capabilityMarker = path.join(externalDirectory, capabilityMarkerName);
  const dataDirectory = path.join(root, "broker-data");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(externalDirectory, { recursive: true }),
  ]);
  await initializeGitFixture(workspace);

  const config = new Config(dataDirectory);
  config.settings.maxSteps = 4;
  config.settings.commandTimeoutMs = 20_000;
  config.settings.auxiliaryModel = "sandbox-verification-approval";
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

    await engine.close();
    engine = undefined;
    await verifyInstalledSubagent(store, config, workspace);
    const capabilityModel = capabilityProvider(
      externalDirectory,
      capabilityProbeCommand(capabilityMarker),
    );
    const capabilitySession = store.create(
      workspace,
      "Runtime capability probe",
    );
    engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      (_settings, purpose) =>
        purpose === "approval" ? approvalProvider() : capabilityModel,
    );
    const capabilityTask = engine.start(
      capabilitySession.id,
      "Write the fixed marker and verify private HTTPS rejection through a reviewed Capability Runner.",
    );
    await waitFor(engine.active!.done, "Capability Runner task");
    if (store.task(capabilityTask.id)?.status !== "completed") {
      fail("Capability Runner task did not complete");
    }

    const capabilityBytes = await readFile(capabilityMarker);
    if (
      !capabilityBytes
        .toString("utf8")
        .replaceAll("\0", "")
        .includes(capabilityMarkerContent)
    ) {
      fail("Capability Runner did not write the expected external marker");
    }

    assertCapabilityRunner(store, capabilitySession.id);
    if (engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount !== 0) {
      fail("Capability Runner left an active generation lease");
    }

    await engine.close();
    engine = undefined;
    const pushModel = blockedPushProvider();
    const pushSession = store.create(workspace, "Runtime push probe");
    engine = new Engine(
      store,
      config,
      pino({ enabled: false }),
      (_settings, purpose) =>
        purpose === "approval" ? approvalProvider() : pushModel,
    );
    const pushTask = engine.start(
      pushSession.id,
      "Attempt the fixed verification push and report its bounded failure.",
    );
    await waitFor(engine.active!.done, "blocked Push Runner task");
    if (store.task(pushTask.id)?.status !== "completed") {
      fail("blocked push result did not return to a completed Runtime task");
    }

    assertBlockedPushRunner(store, pushSession.id);
    if (engine.sandbox.accountGenerationSnapshot()?.activeInstanceCount !== 0) {
      fail("blocked Push Runner left an active generation lease");
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
      "SANDBOX_AGENT_RUNTIME_VERIFY PASS completion=yes subagent=yes capabilityRunner=yes pushRunnerBlocked=yes cancellation=yes cleanup=yes\n",
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
