/**
 * 手动验证冻结发布期间原生 helper 故障的取消与排空，不连接模型或真实项目。
 * 1. 每例创建独占普通来源、私有视图及 Publisher，只通过本进程子 helper 的 PID/控制路径匹配注入故障。
 * 2. validation 例在独立候选视图运行真实 Node 父子进程，失去原视图租约后等待进程树 close，再结束发布。
 * 3. applying 例在首文件替换后终止原视图 helper，检查第二文件未写、unknown/备份/锁保留且拒绝重放。
 * 4. 所有异常挂载必须已退出但不得假装干净恢复；报告仅包含有界结果，不输出命令、路径或正文到 trace。
 * 复用生产 executeProcess 的取消/树清理机制；宿主验证不代替 Sandbox 自动发布生命周期验收。
 * 仅用已安装 WinFsp/helper，不安装驱动、不重启服务、不运行 Evaluation。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLogger } from "../src/logging/logger.js";
import { executeProcess } from "../src/tools/process.js";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
} from "../src/worktrees/overlay.js";
import { nativeBatch } from "./local-overlay/native-batch.js";
import { Publisher } from "./local-overlay/publisher.js";
import { sourceIdentity } from "./local-overlay/files.js";
import type { Batch } from "./local-overlay/session.js";

const execute = promisify(execFile);
assert.equal(process.platform, "win32");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/local-overlay-drain-"));
const log = createLogger(root, "info");

async function killFixtureHelper(control: string) {
  // Query only our immediate helper children; never terminate a service or a
  // helper owned by another task. Resolve the PID immediately before the fault.
  const quoted = control.replaceAll("'", "''");
  const script = `$items = @(Get-CimInstance Win32_Process -Filter "Name='codeatelier-overlay.exe' AND ParentProcessId=${process.pid}" | Where-Object { $_.CommandLine.Contains('${quoted}') }); if ($items.Count -ne 1) { throw 'Fixture helper identity mismatch' }; $items[0].ProcessId`;
  const result = await execute(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    { windowsHide: true, timeout: 10_000, maxBuffer: 8192 },
  );
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  process.kill(pid);
}

function assertExited(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

async function waitForAbort(signal: AbortSignal) {
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
}

async function scenario(mode: "validation" | "applying") {
  const directory = path.join(root, mode);
  const source = path.join(directory, "source");
  await mkdir(source, { recursive: true });
  for (const file of ["a.txt", "b.txt"]) {
    await writeFile(path.join(source, file), "original\n");
  }

  const identity = await sourceIdentity(source);
  const manager = new OverlayManager(directory, log);
  const id = randomUUID();
  const control = path.join(directory, "control");
  const workspace = overlayWorkspace(overlayNamespace(directory), id);
  const publisher = new Publisher(path.join(directory, "publisher"), log);
  let batch: Batch | undefined;
  let callbackDrained = false;
  let processDrained = mode !== "validation";
  let parentPid = 0;
  let childPid = 0;
  let faultInjected = false;

  try {
    await manager.start(
      id,
      source,
      control,
      workspace,
      true,
      AbortSignal.timeout(30_000),
      { kind: "local" },
    );
    for (const file of ["a.txt", "b.txt"]) {
      await writeFile(path.join(workspace, file), "private\n");
    }

    const operation = manager.withFrozen(
      id,
      async (verify, acknowledge, signal) => {
        const captured = await nativeBatch(
          identity,
          control,
          ["a.txt", "b.txt"],
          verify,
        );
        batch = captured;
        try {
          await publisher.publish(batch, {
            nativeWindows: true,
            signal,
            refresh: { request: captured.acknowledgement, acknowledge },
            validate: async (files, validationSignal) => {
              assert.equal(validationSignal, signal);
              if (mode !== "validation") {
                return;
              }

              const validator = new OverlayManager(directory, log);
              const validationId = randomUUID();
              const validationWorkspace = overlayWorkspace(
                overlayNamespace(directory),
                validationId,
              );
              try {
                await validator.start(
                  validationId,
                  source,
                  path.join(directory, "validator"),
                  validationWorkspace,
                  true,
                  signal,
                  { kind: "local" },
                );
                for (const [file, content] of files) {
                  assert.ok(content);
                  await writeFile(
                    path.join(validationWorkspace, file),
                    content,
                  );
                }

                const marker = path.join(directory, "late-marker.txt");
                const child =
                  "const fs=require('node:fs'); process.stdout.write('CHILD '+process.pid+'\\n'); setTimeout(()=>fs.writeFileSync(process.argv[1],'late write'),10000); setInterval(()=>{},1000);";
                const parent =
                  "const fs=require('node:fs'); const {spawn}=require('node:child_process'); if(fs.readFileSync('a.txt','utf8')!=='private\\n') throw Error('Candidate mismatch'); spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);";
                let ready!: () => void;
                const started = new Promise<void>((resolve) => {
                  ready = resolve;
                });
                let output = "";
                const running = executeProcess(
                  process.execPath,
                  ["-e", parent, child, marker],
                  validationWorkspace,
                  signal,
                  20_000,
                  8192,
                  (chunk) => {
                    output += chunk;
                    const match = /CHILD (\d+)/.exec(output);
                    if (match) {
                      childPid = Number(match[1]);
                      ready();
                    }
                  },
                  {},
                  (pid) => {
                    parentPid = pid;
                  },
                );
                try {
                  await Promise.race([
                    started,
                    running.then(() => {
                      throw new Error("Validation exited before barrier");
                    }),
                  ]);
                  await killFixtureHelper(control);
                  faultInjected = true;
                  await running;
                } finally {
                  // executeProcess settles only after close; even a failed fault
                  // injection must await its bounded command before unmounting.
                  await running.catch(() => {});
                  assertExited(parentPid);
                  assertExited(childPid);
                  processDrained = true;
                  await assert.rejects(readFile(marker), { code: "ENOENT" });
                }
              } finally {
                await validator.close();
              }
            },
            afterWrite:
              mode === "applying"
                ? async (index) => {
                    assert.equal(index, 0);
                    await killFixtureHelper(control);
                    faultInjected = true;
                    await waitForAbort(signal);
                  }
                : undefined,
          });
        } finally {
          callbackDrained = true;
        }
      },
    );
    await assert.rejects(operation);
    assert.equal(faultInjected, true);
    assert.equal(callbackDrained, true);
    assert.equal(processDrained, true);
    assert.ok(batch);
    const observed = await publisher.inspect(batch);
    assert.equal(observed.state, mode === "validation" ? "aborted" : "unknown");
    assert.equal(
      await readFile(path.join(source, "a.txt"), "utf8"),
      mode === "validation" ? "original\n" : "private\n",
    );
    assert.equal(
      await readFile(path.join(source, "b.txt"), "utf8"),
      "original\n",
    );
    if (mode === "applying") {
      const backups = (await readdir(source)).filter((file) =>
        file.endsWith(".backup"),
      );
      assert.equal(backups.length, 1);
      assert.equal(
        await readFile(path.join(source, backups[0]!), "utf8"),
        "original\n",
      );
      await assert.rejects(
        publisher.publish(batch, {
          nativeWindows: true,
          lockTimeoutMs: 20,
          validate: async () => {},
        }),
        /LOCK_BUSY_OR_RECOVERY_REQUIRED/,
      );
    } else {
      const keys = await readdir(publisher.directory);
      assert.equal(keys.length, 1);
      assert.equal(
        (await readdir(path.join(publisher.directory, keys[0]!))).includes(
          "publish.lock",
        ),
        false,
      );
    }

    return {
      phase: mode,
      journal: observed.state,
      callbackDrained,
      validationTreeExited: processDrained,
      secondFileUntouched: true,
      helperExit: "injected; not cleanly restorable",
    };
  } finally {
    if (faultInjected) {
      await assert.rejects(manager.close());
    } else {
      await manager.close();
    }
  }
}

const results = [];
for (const mode of ["validation", "applying"] as const) {
  results.push(await scenario(mode));
}

const report = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  release: os.release(),
  node: process.version,
  results,
  limitations: [
    "Host process faults; product Sandbox publication lifecycle not wired",
    "Callbacks must cooperate with signal; uncooperative callbacks remain draining",
    "In-flight replacement is awaited, not rolled back; no multi-file atomicity",
  ],
};
await writeFile(
  path.join(root, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(
  `LOCAL_OVERLAY_DRAIN PASS report=${path.join(root, "report.json")}\n`,
);
