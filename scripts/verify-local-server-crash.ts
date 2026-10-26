/**
 * 手动验收真实服务进程崩溃后的 Local 中断参考闭环，不进入默认检查或 Evaluation。
 * 1. 创建独占来源/设置，以子进程运行生产 App；固定模型发出真实 Sandbox 持文件句柄的部分写入。
 * 2. HTTP 持久事件确认命令已 flush；只读 Windows 探针先绑定 Runtime/命令句柄或 CIM 创建身份，再终止夹具服务。
 * 3. 等待具体进程退出，验证根 ACL 专用模式拒绝文件/枚举、保持 dirty，再重启夹具执行生产授权撤销。
 *    真实鉴权 HTTP 检查中断参考、显式创建新会话，不注入状态/锁；恢复前后只在副本检查元数据。
 * 4. 新 Sandbox 任务读取最新来源和部分参考，重新编辑/候选验证/发布；逐字节核对旧私有证据没有被更改。
 * 5. 报告留在 .local；finally 只关闭本脚本拥有的服务/探针，不停止用户服务、不 Repair、不删除事故锁。
 * 使用已安装的共用 Sandbox 账户，须无其它 Sandbox 任务；具体进程退出不是任意后代完整排空证明。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import pino from "pino";
import { SettingsStore } from "../src/config/settings-store.js";
import type { Session, Snapshot, Task } from "../src/shared/types.js";
import { WinFspLocalBackend } from "../src/local-overlays/backend.js";
import { withLocalInspection } from "../src/local-overlays/inspection-lease.js";
import { withInspectionDatabase } from "../src/local-overlays/inspection-database.js";

assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-server-crash-"));
const data = path.join(root, "data");
const source = path.join(root, "source");
await mkdir(data);
await mkdir(source);
await writeFile(path.join(source, "partial.txt"), "original");
const settings = new SettingsStore(data);
await settings.update({
  expectedRevision: settings.view().revision,
  confirmSensitive: true,
  secretChanges: { mainKey: "local-verification-placeholder" },
  changes: {
    models: {
      main: { baseUrl: "http://127.0.0.1:1/v1", model: "crash-fixture" },
    },
    execution: { maxSteps: 3 },
    sandbox: { enabled: true },
  },
});

async function startServer(phase: "crash" | "restart") {
  const process = spawn(
    globalThis.process.execPath,
    ["--import", "tsx", "scripts/fixtures/local-crash-server.ts", root, phase],
    { windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  const closed = once(process, "close");
  try {
    const [message] = await once(process, "message", {
      signal: AbortSignal.timeout(90_000),
    });
    assert.equal(message.state, "ready");
    const address = String(message.address);
    const bootstrap = await fetch(`${address}/api/bootstrap`);
    assert.equal(bootstrap.status, 200);
    const { token } = (await bootstrap.json()) as { token: string };
    const request = async <T>(url: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${address}${url}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: `ca_session=${token}`,
          "x-codeatelier-token": token,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      assert.equal(response.status, 200, `${url}: ${text}`);
      assert.equal(response.headers.get("cache-control"), "no-store");

      return JSON.parse(text) as T;
    };

    return { process, closed, request };
  } catch (error) {
    process.kill();
    await closed;
    throw error;
  }
}

async function until<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
) {
  const deadline = performance.now() + 90_000;
  for (;;) {
    const value = await read();
    if (accepts(value)) {
      return value;
    }

    assert(performance.now() < deadline, "Timed out waiting for fixture state");
    await delay(250);
  }
}

let server: Awaited<ReturnType<typeof startServer>> | undefined;
let probe: ReturnType<typeof spawn> | undefined;
let probeClosed: Promise<unknown> | undefined;
const report: Record<string, unknown> = {
  root,
  startedAt: new Date().toISOString(),
};
try {
  server = await startServer("crash");
  const original = await server.request<Session>("/api/sessions", {
    workspace: source,
    localOverlay: { id: randomUUID() },
  });
  assert.equal(original.localOverlay?.state, "ready");
  const task = await server.request<Task>(
    `/api/sessions/${original.id}/tasks`,
    { prompt: "Hold a partial write for the crash fixture" },
  );
  const running = await until(
    async () => {
      const value = await server!.request<Snapshot>(
        `/api/sessions/${original.id}`,
      );
      const current = value.tasks.find((item) => item.id === task.id)!;
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(
          current.status,
        )
      ) {
        await writeFile(
          path.join(root, "premature.json"),
          JSON.stringify(value, null, 2),
        );
        assert.fail(
          `Task ended before crash point: ${current.status}: ${current.error}`,
        );
      }

      return value;
    },
    (value) => /CRASH_READY:\d+/.test(JSON.stringify(value.events)),
  );
  const commandPid = Number(
    /CRASH_READY:(\d+)/.exec(JSON.stringify(running.events))![1],
  );
  assert(
    running.events.some(
      (event) =>
        event.type === "sandboxed_tool_process" &&
        event.data.pid === commandPid &&
        event.data.callId === "crash-write",
    ),
  );
  const runtime = running.events.find(
    (event) =>
      event.taskId === task.id &&
      event.type === "execution_instance" &&
      event.data.state === "running" &&
      event.data.mode === "windows-sandbox-user",
  );
  assert(runtime?.data.sandboxApplied);
  const identity = runtime.data as {
    pid: number;
    processCreationTime100ns?: string;
  };
  assert(Number.isSafeInteger(identity.pid));
  assert.equal(running.session.localOverlay?.state, "active");
  assert.equal(
    await readFile(path.join(source, "partial.txt"), "utf8"),
    "original",
  );
  await writeFile(
    path.join(root, "running.json"),
    JSON.stringify(running, null, 2),
  );

  probe = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "scripts/fixtures/wait-local-crash-processes.ps1",
      "-ProcessIds",
      `${identity.pid},${commandPid}`,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] },
  );
  probeClosed = once(probe, "close");
  const lines = createInterface({ input: probe.stdout! });
  const messages: Array<{
    state: string;
    identities?: Array<{ pid: number; created: string; method: string }>;
  }> = [];
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  await until(
    async () => {
      assert.equal(
        probe!.exitCode,
        null,
        "Process probe failed before capturing identities",
      );

      return messages;
    },
    (value) => value.some((message) => message.state === "ready"),
  );
  const captured = messages.find((message) => message.state === "ready")!;
  const capturedRuntime = captured.identities?.find(
    (item) => item.pid === identity.pid,
  );
  if (
    identity.processCreationTime100ns &&
    capturedRuntime?.method === "process-handle"
  ) {
    assert.equal(
      captured.identities?.find((item) => item.pid === identity.pid)?.created,
      identity.processCreationTime100ns,
    );
  } else if (
    identity.processCreationTime100ns &&
    capturedRuntime?.method === "cim-creation-identity"
  ) {
    const stamp = /^(.*)\.(\d{7})Z$/.exec(capturedRuntime.created);
    assert(stamp, "Expected UTC CIM creation timestamp");
    const fileTime =
      BigInt(Date.parse(stamp[1] + "Z")) * 10000n +
      BigInt(stamp[2]) +
      116444736000000000n;
    const difference = BigInt(identity.processCreationTime100ns) - fileTime;
    // CIM truncates Windows creation FILETIME to microseconds; bind the observed
    // identity to the production Runtime receipt within that precision only.
    assert(
      difference >= 0n && difference < 10n,
      "CIM identity differs from Runtime receipt",
    );
  }

  server.process.kill();
  await server.closed;
  server = undefined;
  const [probeCode] = (await probeClosed) as [number];
  assert.equal(probeCode, 0);
  assert(messages.some((message) => message.state === "exited"));
  report.processProof = messages;
  report.interruptedTaskId = task.id;
  const directory = path.join(data, "local-overlays");
  const id = original.localOverlay!.id;
  const control = path.join(directory, id);
  const beforeManifest = await readFile(path.join(directory, `${id}.json`));
  const beforeOwner = await readFile(path.join(control, "mount.lock"));
  const record = JSON.parse(beforeManifest.toString());
  const privateState = () =>
    withLocalInspection(control, AbortSignal.timeout(15000), (signal) =>
      withInspectionDatabase(
        path.join(control, "overlay.sqlite"),
        path.join(root, "inspection"),
        signal,
        [source, control],
        async (file) => {
          const db = new DatabaseSync(file);
          try {
            return {
              meta: db.prepare("SELECT * FROM meta").all(),
              state: db.prepare("SELECT * FROM local_state").all(),
              baselines: db
                .prepare("SELECT * FROM baselines ORDER BY path")
                .all(),
              nodes: db
                .prepare("SELECT * FROM nodes WHERE id<>1 ORDER BY id")
                .all(),
            };
          } finally {
            db.close();
          }
        },
      ),
    );
  const beforeState = await privateState();
  assert.equal(beforeState.meta[0].clean, 0);
  const backend = new WinFspLocalBackend(directory, pino({ enabled: false }));
  const accessMount = await backend.recoverAccess(
    id,
    source,
    control,
    AbortSignal.timeout(15000),
  );
  try {
    assert.equal(await accessMount.identity(), record.workspaceIdentity);
    const denied = (error: NodeJS.ErrnoException) =>
      error.code === "EPERM" || error.code === "EACCES";
    await assert.rejects(readdir(original.workspace), denied);
    await assert.rejects(
      readFile(path.join(original.workspace, "partial.txt")),
      denied,
    );
    await assert.rejects(
      writeFile(path.join(original.workspace, "denied.txt"), "forbidden"),
      denied,
    );
  } finally {
    await accessMount.close();
  }

  assert.deepEqual(await privateState(), beforeState);
  server = await startServer("restart");
  assert.deepEqual(await privateState(), beforeState);
  assert.deepEqual(
    await readFile(path.join(directory, `${id}.json`)),
    beforeManifest,
  );
  assert.deepEqual(
    await readFile(path.join(control, "mount.lock")),
    beforeOwner,
  );
  await assert.rejects(
    backend.open(id, source, control, false, AbortSignal.timeout(15000)),
  );
  report.dirtyPreserved = true;
  report.rootOnlySurface =
    "root identity available; enumeration, existing file read and new file write denied";
  const interrupted = await server.request<Snapshot>(
    `/api/sessions/${original.id}`,
  );
  assert.equal(interrupted.tasks.length, 1);
  assert.equal(interrupted.tasks[0].status, "interrupted");
  assert(interrupted.session.localOverlay?.interruptedReview);

  const preserved = [
    `${id}.json`,
    `${id}.lock`,
    `${id}/overlay.sqlite`,
    `${id}/overlay.sqlite-wal`,
    `${id}/mount.lock`,
  ];
  const evidence = () =>
    Promise.all(
      preserved.map(async (name) =>
        readFile(path.join(directory, name)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              return null;
            }

            throw error;
          },
        ),
      ),
    );
  const before = await evidence();
  const selection = { paths: ["partial.txt"], state: "interrupted" };
  const reviewed = await server.request<{
    version: string;
    state: string;
    files: Array<{ path: string; private: { content: string } }>;
  }>(`/api/sessions/${original.id}/local-review`, selection);
  assert.equal(reviewed.state, "interrupted");
  assert.equal(reviewed.files.length, 1);
  assert.equal(reviewed.files[0].path, "partial.txt");
  assert.equal(
    Buffer.from(reviewed.files[0].private.content, "base64").toString("utf8"),
    "private prefix only",
  );
  await writeFile(path.join(source, "partial.txt"), "current source");
  const child = await server.request<Session>(
    `/api/sessions/${original.id}/local-resolution`,
    { ...selection, id: randomUUID(), version: reviewed.version },
  );
  assert.equal(child.localOverlay?.resolution?.state, "interrupted");
  assert.equal(
    (await server.request<Snapshot>(`/api/sessions/${child.id}`)).tasks.length,
    0,
  );
  const next = await server.request<Task>(`/api/sessions/${child.id}/tasks`, {
    prompt:
      "Read current source and interrupted reference, then explicitly edit and validate",
  });
  const finished = await until(
    () => server!.request<Snapshot>(`/api/sessions/${child.id}`),
    (value) =>
      value.tasks.some(
        (item) =>
          item.id === next.id &&
          ["completed", "failed", "cancelled", "interrupted"].includes(
            item.status,
          ),
      ),
  );
  await writeFile(
    path.join(root, "finished.json"),
    JSON.stringify(finished, null, 2),
  );
  assert.equal(
    finished.tasks.find((item) => item.id === next.id)?.status,
    "completed",
  );
  assert.equal(finished.session.localOverlay?.publication?.state, "published");
  assert.equal(finished.session.localOverlay?.publication?.files, 1);
  const executions = finished.events.filter(
    (event) => event.type === "execution_instance",
  );
  assert(
    executions.some(
      (event) =>
        event.data.state === "completed" &&
        event.data.purpose === "local-validation" &&
        event.data.sandboxApplied === true,
    ),
  );
  assert(
    executions.some(
      (event) =>
        event.data.state === "completed" &&
        event.data.mode === "windows-sandbox-user" &&
        event.data.sandboxApplied === true,
    ),
  );
  assert(!executions.some((event) => event.data.kind === "host-process"));
  assert.equal(
    await readFile(path.join(source, "partial.txt"), "utf8"),
    "resolved after real crash",
  );
  assert.deepEqual(await evidence(), before);
  report.checks = [
    "actual service killed during Sandbox held partial write",
    "pre-bound Runtime and command identities exited (see per-process evidence method)",
    "real interrupted task retained after restart",
    "HTTP reference continuation starts no task",
    "new Sandbox edit and candidate publication succeed",
    "old private manifest locks and SQLite bytes unchanged",
  ];
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  if (server) {
    server.process.send("stop");
    await server.closed;
  }

  if (probe && probe.exitCode === null) {
    probe.kill();
    await probeClosed;
  }

  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
