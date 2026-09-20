/**
 * 把 SandboxBroker 的已审批命令交给 Windows 专用账户 C++ supervisor，并保持禁用/失败时的宿主路径不变。
 * Runtime factory 仅在 Windows 且开关开启时创建本类；selfCheck 必须同时验证安装 state、二进制摘要、账户凭据与 WFP。
 *
 * 1. installationPaths 解析固定产品路径或显式测试覆盖，不从工作区或模型输入选择可执行文件。
 * 2. selfCheck 严格读取受限 state 元数据、复核 supervisor/network SHA-256，再调用原生只读自检。
 * 3. encodeRequest 把唯一 execution instance、固定 shell argv、cwd、私有目录和时限编码为有界二进制帧。
 * 4. execute 启动单实例 supervisor，stdout 作为工具输出流，stderr 只解析 runtime PID、完成和固定错误类别。
 * 5. 取消或 JS 超时关闭继承 stdin；原生 supervisor 据此终止 Job 并撤销 ACL。清理失败码会抛出未知结果，绝不宿主重放。
 * 6. 临时 HOME/TEMP 只在原生确认撤销后删除；日志与错误不包含命令、路径、SID、端口、密码或工具输出。
 *
 * 该实现当前承载 run_command；Git 与文件工具接入同一 Runtime transport 前，产品文档仍不得宣称完整 Sandbox 已完成。
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { executeProcess, TerminalTextSanitizer } from "../tools/process.js";
import type {
  SandboxCommand,
  SandboxRuntime,
  SandboxWorkspace,
} from "./types.js";

const REQUEST_MAGIC = 0x42534143;
const REQUEST_VERSION = 1;
const CLEANUP_FAILURE_EXIT_CODE = 70;
const SELF_CHECK_FAILURE_EXIT_CODE = 71;
const PROTOCOL_FAILURE_EXIT_CODE = 72;
const MAXIMUM_ARGUMENTS = 64;
const MAXIMUM_STRING_BYTES = 64 * 1024;

interface InstallationPaths {
  supervisor: string;
  networkManager: string;
  state: string;
}

interface InstallationMetadata {
  generationId: string;
  supervisorSha256: string;
  networkSha256: string;
}

export class NativeWindowsSandboxError extends Error {
  readonly code = "WINDOWS_SANDBOX_NATIVE";

  constructor(reason: string) {
    super(`Windows Sandbox Runtime 不可用：${reason}`);
    this.name = "NativeWindowsSandboxError";
  }
}

function installationPaths(
  environment: NodeJS.ProcessEnv = process.env,
): InstallationPaths {
  const nativeRoot = environment.CODEATELIER_SANDBOX_NATIVE_ROOT
    ? path.resolve(environment.CODEATELIER_SANDBOX_NATIVE_ROOT)
    : path.resolve(process.cwd(), "dist", "native", "windows-x64");
  const programData = environment.ProgramData;
  const state = environment.CODEATELIER_SANDBOX_STATE_PATH
    ? path.resolve(environment.CODEATELIER_SANDBOX_STATE_PATH)
    : programData
      ? path.join(programData, "CodeAtelier", "Sandbox", "installation.state")
      : "";

  return {
    supervisor: path.join(nativeRoot, "codeatelier-sandbox-supervisor.exe"),
    networkManager: path.join(nativeRoot, "codeatelier-sandbox-network.exe"),
    state,
  };
}

function parseState(content: string): InstallationMetadata {
  const values = new Map<string, string>();
  for (const line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new NativeWindowsSandboxError("installation state 包含非法行。");
    }

    const key = line.slice(0, separator);
    if (values.has(key)) {
      throw new NativeWindowsSandboxError("installation state 包含重复字段。");
    }

    values.set(key, line.slice(separator + 1));
  }

  const generationId = values.get("generationId") ?? "";
  const supervisorSha256 = values.get("supervisorSha256") ?? "";
  const networkSha256 = values.get("networkSha256") ?? "";
  if (
    values.get("version") !== "1" ||
    !/^[0-9a-f-]{36}$/i.test(generationId) ||
    !/^[a-f0-9]{64}$/i.test(supervisorSha256) ||
    !/^[a-f0-9]{64}$/i.test(networkSha256)
  ) {
    throw new NativeWindowsSandboxError("installation state 版本或摘要无效。");
  }

  return { generationId, supervisorSha256, networkSha256 };
}

async function fileSha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function framedString(value: string) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > MAXIMUM_STRING_BYTES) {
    throw new NativeWindowsSandboxError("执行请求字符串超过协议限制。");
  }

  const size = Buffer.allocUnsafe(4);
  size.writeUInt32LE(encoded.byteLength);

  return Buffer.concat([size, encoded]);
}

export function encodeNativeSandboxRequest(input: {
  executionInstanceId: string;
  cwd: string;
  command: string;
  args: string[];
  privateDirectory: string;
  timeoutMs: number;
}) {
  if (
    !input.executionInstanceId ||
    !input.cwd ||
    !path.isAbsolute(input.cwd) ||
    !input.command ||
    !path.isAbsolute(input.command) ||
    !input.privateDirectory ||
    !path.isAbsolute(input.privateDirectory) ||
    input.args.length > MAXIMUM_ARGUMENTS ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 0xffff_ffff
  ) {
    throw new NativeWindowsSandboxError("执行请求字段无效。");
  }

  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(REQUEST_MAGIC, 0);
  header.writeUInt32LE(REQUEST_VERSION, 4);
  const timeout = Buffer.allocUnsafe(4);
  timeout.writeUInt32LE(input.timeoutMs);
  const argumentCount = Buffer.allocUnsafe(4);
  argumentCount.writeUInt32LE(input.args.length);

  return Buffer.concat([
    header,
    framedString(input.executionInstanceId),
    framedString(input.cwd),
    framedString(input.command),
    framedString(input.privateDirectory),
    timeout,
    argumentCount,
    ...input.args.map(framedString),
  ]);
}

export class NativeWindowsSandboxRuntime implements SandboxRuntime {
  private paths: InstallationPaths;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private runSelfCheck = executeProcess,
    private log?: Logger,
  ) {
    this.paths = installationPaths(environment);
  }

  async selfCheck(signal: AbortSignal, _workspace: SandboxWorkspace) {
    void _workspace;
    const startedAt = performance.now();
    this.log?.info({
      event: "sandbox.install_attest.started",
      module: "sandbox",
    });
    if (!this.paths.state) {
      throw new NativeWindowsSandboxError("ProgramData 路径不可用。");
    }

    let metadata: InstallationMetadata;
    try {
      metadata = parseState(await readFile(this.paths.state, "utf8"));
      const [supervisorDigest, networkDigest] = await Promise.all([
        fileSha256(this.paths.supervisor),
        fileSha256(this.paths.networkManager),
      ]);
      if (
        supervisorDigest !== metadata.supervisorSha256.toLocaleLowerCase() ||
        networkDigest !== metadata.networkSha256.toLocaleLowerCase()
      ) {
        throw new NativeWindowsSandboxError("原生二进制摘要与安装记录不一致。");
      }
    } catch (error) {
      if (error instanceof NativeWindowsSandboxError) {
        throw error;
      }

      throw new NativeWindowsSandboxError("安装状态或原生二进制不可读。");
    }

    const result = await this.runSelfCheck(
      this.paths.supervisor,
      ["--self-check", this.paths.state, this.paths.networkManager],
      process.cwd(),
      signal,
      20_000,
      4_096,
      () => {},
      {},
    );
    if (
      result.exitCode !== 0 ||
      !result.output.includes("CODEATELIER_SELF_CHECK_OK")
    ) {
      throw new NativeWindowsSandboxError("账户、凭据或 WFP 自检失败。");
    }

    this.log?.info({
      event: "sandbox.install_attest.completed",
      module: "sandbox",
      durationMs: Math.round(performance.now() - startedAt),
      result: "verified",
    });

    return {
      level: `windows-sandbox-user-v1:${createHash("sha256").update(metadata.generationId).digest("hex").slice(0, 12)}`,
      workspaceProtection: "direct-path" as const,
      accountGenerationDigest: createHash("sha256")
        .update(metadata.generationId)
        .digest("hex"),
    };
  }

  async execute(command: SandboxCommand, _workspace: SandboxWorkspace) {
    void _workspace;
    const privateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "codeatelier-sandbox-"),
    );
    const frame = encodeNativeSandboxRequest({
      executionInstanceId: command.executionInstanceId,
      cwd: command.cwd,
      command: command.command,
      args: command.args,
      privateDirectory,
      timeoutMs: command.timeoutMs,
    });

    try {
      return await this.spawnSupervisor(command, frame);
    } finally {
      await rm(privateDirectory, { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }

  private spawnSupervisor(command: SandboxCommand, frame: Buffer) {
    command.signal.throwIfAborted();

    return new Promise<{
      output: string;
      exitCode: number | null;
      truncated: boolean;
    }>((resolve, reject) => {
      const child = spawn(
        this.paths.supervisor,
        ["--execute", this.paths.state, this.paths.networkManager],
        {
          cwd: command.cwd,
          windowsHide: true,
          shell: false,
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            ComSpec: process.env.ComSpec,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let outputSize = 0;
      let control = "";
      let finished = false;
      let timedOut = false;
      let cleanupFailure = false;
      const sanitizer = new TerminalTextSanitizer();

      if (child.pid !== undefined) {
        command.onProcessStarted(child.pid, "runtime-launcher");
        this.log?.info({
          event: "sandbox.supervisor_control.started",
          module: "sandbox",
          sessionId: command.sessionId,
          taskId: command.taskId,
          executionInstanceId: command.executionInstanceId,
          supervisorPid: child.pid,
        });
      }

      const cancel = () => child.stdin.end();
      const timer = setTimeout(() => {
        timedOut = true;
        child.stdin.end();
      }, command.timeoutMs + 5_000);
      command.signal.addEventListener("abort", cancel, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const text = sanitizer.write(chunk);
        outputSize += text.length;
        const accepted = text.slice(
          0,
          Math.max(0, command.outputLimit - output.length),
        );
        output += accepted;
        if (accepted) {
          command.onOutput(accepted);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        control = (control + chunk).slice(-16_384);
        for (const match of control.matchAll(
          /CODEATELIER_RUNTIME_STARTED pid=(\d+)/g,
        )) {
          const pid = Number(match[1]);
          if (Number.isSafeInteger(pid) && pid > 0) {
            command.onProcessStarted(pid, "runtime");
            this.log?.info({
              event: "sandbox.runtime_provision.completed",
              module: "sandbox",
              sessionId: command.sessionId,
              taskId: command.taskId,
              executionInstanceId: command.executionInstanceId,
              runtimePid: pid,
            });
          }
        }

        cleanupFailure ||= control.includes(
          "CODEATELIER_SUPERVISOR_ERROR category=cleanup",
        );
      });
      child.once("error", (error) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);
        command.signal.removeEventListener("abort", cancel);
        reject(
          new NativeWindowsSandboxError(
            error instanceof Error && error.message
              ? "无法启动已验证的 supervisor。"
              : "supervisor 启动失败。",
          ),
        );
      });
      child.once("close", (exitCode) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);
        command.signal.removeEventListener("abort", cancel);
        if (command.signal.aborted) {
          this.log?.info({
            event: "sandbox.instance_release.completed",
            module: "sandbox",
            sessionId: command.sessionId,
            taskId: command.taskId,
            executionInstanceId: command.executionInstanceId,
            result: "cancelled",
          });
          reject(command.signal.reason ?? new Error("任务已取消"));
        } else if (timedOut) {
          reject(new Error("命令超时，Sandbox Job 已终止。"));
        } else if (cleanupFailure || exitCode === CLEANUP_FAILURE_EXIT_CODE) {
          this.log?.error({
            event: "sandbox.instance_release.failed",
            module: "sandbox",
            sessionId: command.sessionId,
            taskId: command.taskId,
            executionInstanceId: command.executionInstanceId,
            category: "cleanup",
          });
          reject(new NativeWindowsSandboxError("ACL 或 Job 清理结果未知。"));
        } else if (
          exitCode === SELF_CHECK_FAILURE_EXIT_CODE ||
          exitCode === PROTOCOL_FAILURE_EXIT_CODE
        ) {
          reject(new NativeWindowsSandboxError("supervisor 安全拒绝了执行。"));
        } else {
          this.log?.info({
            event: "sandbox.instance_release.completed",
            module: "sandbox",
            sessionId: command.sessionId,
            taskId: command.taskId,
            executionInstanceId: command.executionInstanceId,
            result: "clean",
            exitCode,
          });
          resolve({
            output,
            exitCode,
            truncated: outputSize > command.outputLimit,
          });
        }
      });
      child.stdin.write(frame, (error) => {
        if (error && !finished) {
          child.stdin.end();
        }
      });
    });
  }
}
