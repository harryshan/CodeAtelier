/**
 * 离线验证 MXC 产品启动器的策略、启动首帧、文件快照、持久标记及失败关闭。
 * 1. 假 SDK 只提供可控流和退出结果，不启动原生后端；测试真实 Broker/MxcSandboxRuntime 与临时文件系统。
 * 2. 正常路径验证授权根、无宿主环境、实例 mode/PID kind、nonce 只经首帧和幂等释放。
 * 3. 损坏 bundle、危险根、残留标记、SDK/清理失败、迟到 handle 和取消覆盖不重放与隔离。
 * 4. Mac 仅检查生成策略，不把假 SDK 或普通单测当 macOS 实机证据；Linux 原生验证另有手动入口。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  MxcSandboxRuntime,
  type MxcRuntimeOptions,
} from "../src/sandbox/mxc-runtime.js";
import { MXC_RUNTIME_FILES } from "../src/sandbox/mxc-runtime-files.js";
import { createMxcRequest } from "../src/sandbox/mxc-policy.js";
import { SandboxBroker } from "../src/sandbox/broker.js";
import { sandboxConfiguration } from "../src/sandbox/config.js";
import { temp } from "./fixtures/helpers.js";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { TraceRecorder } from "../src/tracing/recorder.js";

const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }

  roots.clear();
});

async function fixture(overrides: Partial<MxcRuntimeOptions> = {}) {
  const root = await temp();
  const dataDirectory = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const bundleDirectory = path.join(root, "bundle");
  const nodeExecutable = path.join(root, "toolchain", "bin", "node");
  for (const directory of [
    dataDirectory,
    workspace,
    bundleDirectory,
    path.dirname(nodeExecutable),
  ]) {
    await mkdir(directory, { recursive: true });
  }

  await writeFile(nodeExecutable, "test-only node placeholder");
  const files: Record<string, string> = {};
  for (const file of MXC_RUNTIME_FILES) {
    await writeFile(path.join(bundleDirectory, file), `fixture ${file}`);
    files[file] = createHash("sha256").update(`fixture ${file}`).digest("hex");
  }

  await writeFile(
    path.join(bundleDirectory, "runtime.manifest.json"),
    JSON.stringify({ version: 1, nodeMajor: 24, files }),
  );
  const traces = new TraceRecorder();
  const requests: ContainerRequest[] = [];
  const handles: ReturnType<typeof handle>[] = [];
  const sdk = {
    getPlatformSupport: () =>
      ({ isSupported: true, availableMethods: ["bubblewrap"] as const }) as any,
    spawn: vi.fn(async (request: ContainerRequest) => {
      requests.push(request);
      roots.add(path.dirname(request.environment!.HOME!));
      const child = handle();
      handles.push(child);

      return child;
    }),
  };
  const runtime = new MxcSandboxRuntime({
    platform: "linux",
    dataDirectory,
    bundleDirectory,
    nodeExecutable,
    traces,
    loadSdk: async () => sdk,
    cleanupTimeoutMs: 30,
    ...overrides,
  });
  const broker = new SandboxBroker(
    sandboxConfiguration({ CODEATELIER_SANDBOX_ENABLED: "true" }, "linux"),
    runtime,
  );
  const input = {
    identity: {
      sessionId: "session",
      taskId: randomUUID(),
      executionInstanceId: randomUUID(),
      kind: "agent-runtime" as const,
    },
    nonce: "a".repeat(64),
    workspace,
    signal: new AbortController().signal,
  };
  traces.startTask(input.identity.taskId, "session");

  return {
    root,
    dataDirectory,
    workspace,
    bundleDirectory,
    runtime,
    broker,
    input,
    sdk,
    requests,
    handles,
    traces,
    journal: path.join(dataDirectory, "mxc", "active"),
  };
}

function handle() {
  let resolve!: (result: { exitCode: number; timedOut: boolean }) => void;
  const exited = new Promise<{ exitCode: number; timedOut: boolean }>(
    (done) => {
      resolve = done;
    },
  );

  return {
    id: 12345,
    standardInput: new PassThrough(),
    standardOutput: new PassThrough(),
    standardError: new PassThrough(),
    kill: vi.fn(() => resolve({ exitCode: 0, timedOut: false })),
    wait: vi.fn(() => exited),
    dispose: vi.fn(),
  };
}

it("launches private IPC with fixed policy, snapshots, honest attribution and idempotent cleanup", async () => {
  const f = await fixture();
  const child = await f.broker.launch(f.input);
  const request = f.requests[0]!;
  expect(request).toMatchObject({
    containment: { type: "bubblewrap" },
    timeoutMs: 0,
    inheritDefaultEnvironment: false,
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
  });
  expect(request.command).not.toContain(f.input.nonce);
  expect(Object.keys(request.environment!).sort()).toEqual([
    "HOME",
    "LANG",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]);
  const frame = f.handles[0]!.standardInput.read() as Buffer;
  expect(JSON.parse(frame.subarray(4).toString())).toMatchObject({
    nonce: f.input.nonce,
    identity: f.input.identity,
  });
  expect(child).toMatchObject({
    mode: "linux-bubblewrap",
    pidKind: "runtime-launcher",
    pid: 12345,
  });
  expect(
    f.broker.statusFor(
      f.input.identity.taskId,
      f.input.identity.executionInstanceId,
    ),
  ).toMatchObject({ mode: "sandboxed", platform: "linux", applied: true });
  expect(await readdir(f.journal)).toHaveLength(1);
  expect(
    await readFile(
      path.join(request.filesystem!.readonlyPaths![0]!, "agent-runtime.mjs"),
      "utf8",
    ),
  ).toBe("fixture agent-runtime.mjs");
  expect(
    await Promise.all([child.close("completed"), child.close("completed")]),
  ).toEqual(["clean", "clean"]);
  expect(f.handles[0]!.kill).toHaveBeenCalledTimes(1);
  expect(await readdir(f.journal)).toEqual([]);
  const trace = JSON.stringify(f.traces.exportTask(f.input.identity.taskId));
  expect(trace).toContain("sandbox.mxc.launch");
  expect(trace).toContain("sandbox.mxc.cleanup");
  expect(trace).not.toContain(f.input.nonce);
  expect(trace).not.toContain(f.workspace.replaceAll("\\", "\\\\"));
});

it("generates restrictive Seatbelt settings without exercising macOS", () => {
  const request = createMxcRequest({
    platform: "darwin",
    workspace: "/work space",
    node: "/node/bin/node",
    code: "/private/code",
    home: "/private/home",
    temporary: "/private/tmp",
    brokerData: "/broker",
    readRoots: [],
    writeRoots: [],
  });
  expect(request.containment).toEqual({
    type: "seatbelt",
    config: {
      guiAccess: false,
      keychainAccess: false,
      nestedPty: false,
      extraMachLookups: [],
    },
  });
  expect(request.filesystem!.deniedPaths).toEqual(["/broker"]);
  expect(request.inheritDefaultEnvironment).toBe(false);
  expect(request.network!.egress!.default).toBe("deny");
});

it("rejects corrupt runtime code and workspace grants overlapping Broker data before spawning", async () => {
  const f = await fixture();
  await writeFile(path.join(f.bundleDirectory, "agent-runtime.mjs"), "corrupt");
  await expect(f.broker.launch(f.input)).rejects.toThrow("摘要");
  await expect(
    f.broker.launch({ ...f.input, workspace: f.root }),
  ).rejects.toThrow("重叠");
  expect(f.sdk.spawn).not.toHaveBeenCalled();
  expect(await readdir(f.journal)).toEqual([]);
});

it("refuses leftover launch journals without killing a stale PID or invoking SDK", async () => {
  const f = await fixture();
  await mkdir(f.journal, { recursive: true });
  await writeFile(path.join(f.journal, "old.json"), "unknown previous launch");
  await expect(f.broker.launch(f.input)).rejects.toThrow("未核对");
  expect(f.sdk.spawn).not.toHaveBeenCalled();
  expect(await readdir(f.journal)).toEqual(["old.json"]);
});

it("quarantines failed SDK launches and never retries or selects host fallback", async () => {
  const f = await fixture();
  f.sdk.spawn.mockRejectedValue(
    new Error("spawn failed after unknown native effects"),
  );
  await expect(f.broker.launch(f.input)).rejects.toMatchObject({
    code: "SANDBOX_UNAVAILABLE",
  });
  await expect(f.broker.launch(f.input)).rejects.toThrow("隔离");
  expect(f.sdk.spawn).toHaveBeenCalledTimes(1);
  expect(await readdir(f.journal)).toHaveLength(1);
  expect(
    f.broker.statusFor(
      f.input.identity.taskId,
      f.input.identity.executionInstanceId,
    ).mode,
  ).toBe("unknown");
  const journals = await readdir(f.journal);
  roots.add(
    JSON.parse(await readFile(path.join(f.journal, journals[0]!), "utf8")).root,
  );
});

it("drains peer handles and keeps journals when an instance loses its terminal result", async () => {
  const f = await fixture();
  const a = await f.broker.launch(f.input);
  await f.broker.launch({
    ...f.input,
    identity: { ...f.input.identity, executionInstanceId: randomUUID() },
  });
  expect(await a.close("unknown")).toBe("orphaned");
  expect(f.handles.every((child) => child.kill.mock.calls.length === 1)).toBe(
    true,
  );
  expect(await readdir(f.journal)).toHaveLength(2);
  await expect(f.broker.launch(f.input)).rejects.toThrow("隔离");
});

it("retains evidence and blocks reuse when cleanup cannot prove process exit", async () => {
  const f = await fixture();
  const a = await f.broker.launch(f.input);
  f.handles[0]!.kill.mockImplementation(() => {});
  expect(await a.close("completed")).toBe("orphaned");
  expect(await readdir(f.journal)).toHaveLength(1);
  await expect(f.broker.launch(f.input)).rejects.toThrow("隔离");
});

it("collects late SDK handles after a bounded startup without replaying", async () => {
  const f = await fixture({ startupTimeoutMs: 10 });
  const late = handle();
  let deliver!: (value: ReturnType<typeof handle>) => void;
  f.sdk.spawn.mockImplementation(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  await expect(f.broker.launch(f.input)).rejects.toMatchObject({
    code: "SANDBOX_UNAVAILABLE",
  });
  deliver(late);
  await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
  expect(f.sdk.spawn).toHaveBeenCalledOnce();
  const journals = await readdir(f.journal);
  expect(journals).toHaveLength(1);
  roots.add(
    JSON.parse(await readFile(path.join(f.journal, journals[0]!), "utf8")).root,
  );
});

it("rejects cancellation before spawn without leaving a journal", async () => {
  const f = await fixture();
  await expect(
    f.broker.launch({ ...f.input, signal: AbortSignal.abort() }),
  ).rejects.toBeDefined();
  expect(f.sdk.spawn).not.toHaveBeenCalled();
});
