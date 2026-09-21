/**
 * 把 SandboxBroker 的已审批命令交给 Windows 专用账户 C++ supervisor，并保持禁用/失败时的宿主路径不变。
 * Runtime factory 仅在 Windows 且开关开启时创建本类；selfCheck 必须同时验证安装 state、二进制摘要、账户凭据与 WFP。
 *
 * 1. installationPaths 解析 ProgramData 下受保护的产品副本或显式测试覆盖，不从工作区或模型输入选择可执行文件。
 * 2. selfCheck 严格读取受限 state 元数据、复核 supervisor/network 与固定 Node 24/Runtime bundle SHA-256，并在首次接单前排空旧账户进程和 ACL journal。
 * 3. prepareAccess 在 manifest 前创建 Git 投影和逐实例 HOME/TEMP，使私有目录也经过原对象 ACL/capability/journal；encodeRequest 再发送固定执行帧。
 * 4. execute 启动单实例 supervisor，stdout 作为工具输出流，stderr 只解析 runtime PID/创建时间、完成和固定错误类别。
 * 5. runtime started 控制帧确认共享账户 ACE 已安装；并发 lease 在该确认前不会假定 grant 可用。
 * 6. 取消或 JS 超时关闭继承 stdin；清理失败优先于取消结果并抛出专用 unknown 错误，绝不宿主重放。
 * 7. drainGeneration 关闭 relay、终止该账户全部进程并按持久 journal 撤销 ACL，供在线 quarantine 与重启恢复共用。
 * 8. 临时 HOME/TEMP 只在原生确认撤销后删除；日志与错误不包含命令、路径、SID、端口、密码或工具输出。
 *
 * 该实现当前承载 run_command 和全部 Git 子进程；文件读写仍由 Broker 的固定 schema 与快照编辑器执行。
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { executeProcess, TerminalTextSanitizer } from "../tools/process.js";
import type {
  SandboxCommand,
  SandboxNativeAccess,
  SandboxRevokeRoot,
  SandboxRuntime,
  SandboxWorkspace,
} from "./types.js";
import { discoverGitConfigGraph } from "./git-config-graph.js";
import { SandboxHttpsRelay, type IssuedRelayLease } from "./https-relay.js";
import type { TraceRecorder } from "../tracing/recorder.js";

const REQUEST_MAGIC = 0x42534143;
const REQUEST_VERSION = 2;
const CLEANUP_FAILURE_EXIT_CODE = 70;
const SELF_CHECK_FAILURE_EXIT_CODE = 71;
const PROTOCOL_FAILURE_EXIT_CODE = 72;
const MAXIMUM_ARGUMENTS = 64;
const MAXIMUM_STRING_BYTES = 64 * 1024;

export function classifySupervisorClose(input: {
  aborted: boolean;
  timedOut: boolean;
  cleanupFailure: boolean;
  exitCode: number | null;
}) {
  if (input.cleanupFailure || input.exitCode === CLEANUP_FAILURE_EXIT_CODE) {
    return "cleanup_unknown" as const;
  }

  if (input.aborted) {
    return "cancelled" as const;
  }

  if (input.timedOut) {
    return "timed_out" as const;
  }

  if (
    input.exitCode === SELF_CHECK_FAILURE_EXIT_CODE ||
    input.exitCode === PROTOCOL_FAILURE_EXIT_CODE
  ) {
    return "security_rejected" as const;
  }

  return "completed" as const;
}

interface InstallationPaths {
  supervisor: string;
  networkManager: string;
  runtimeNode: string;
  runtimeEntry: string;
  runtimeWorker: string;
  state: string;
  dataRoot: string;
}

interface InstallationMetadata {
  generationId: string;
  supervisorSha256: string;
  networkSha256: string;
  runtimeNodeSha256: string;
  runtimeEntrySha256: string;
  runtimeWorkerSha256: string;
  relayPortV4: number;
}

export class NativeWindowsSandboxError extends Error {
  readonly code: string = "WINDOWS_SANDBOX_NATIVE";

  constructor(reason: string) {
    super(`Windows Sandbox Runtime 不可用：${reason}`);
    this.name = "NativeWindowsSandboxError";
  }
}

export class NativeWindowsSandboxCleanupError extends NativeWindowsSandboxError {
  override readonly code = "WINDOWS_SANDBOX_CLEANUP_UNKNOWN";

  constructor(reason: string) {
    super(reason);
    this.name = "NativeWindowsSandboxCleanupError";
  }
}

function installationPaths(
  environment: NodeJS.ProcessEnv = process.env,
): InstallationPaths {
  const programData = environment.ProgramData;
  const nativeRoot = environment.CODEATELIER_SANDBOX_NATIVE_ROOT
    ? path.resolve(environment.CODEATELIER_SANDBOX_NATIVE_ROOT)
    : programData
      ? path.join(programData, "CodeAtelier", "Sandbox", "bin")
      : "";
  const state = environment.CODEATELIER_SANDBOX_STATE_PATH
    ? path.resolve(environment.CODEATELIER_SANDBOX_STATE_PATH)
    : programData
      ? path.join(programData, "CodeAtelier", "Sandbox", "installation.state")
      : "";
  const dataRoot = state ? path.dirname(state) : "";
  const runtimeRoot = dataRoot ? path.join(dataRoot, "runtime") : "";

  return {
    supervisor: path.join(nativeRoot, "codeatelier-sandbox-supervisor.exe"),
    networkManager: path.join(nativeRoot, "codeatelier-sandbox-network.exe"),
    runtimeNode: path.join(runtimeRoot, "node.exe"),
    runtimeEntry: path.join(runtimeRoot, "agent-runtime.mjs"),
    runtimeWorker: path.join(runtimeRoot, "compaction-worker.mjs"),
    state,
    dataRoot,
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
  const runtimeNodeSha256 = values.get("runtimeNodeSha256") ?? "";
  const runtimeEntrySha256 = values.get("runtimeEntrySha256") ?? "";
  const runtimeWorkerSha256 = values.get("runtimeWorkerSha256") ?? "";
  const relayPortV4 = Number(values.get("relayPortV4"));
  if (
    values.get("version") !== "2" ||
    !/^[0-9a-f-]{36}$/i.test(generationId) ||
    !/^[a-f0-9]{64}$/i.test(supervisorSha256) ||
    !/^[a-f0-9]{64}$/i.test(networkSha256) ||
    !/^[a-f0-9]{64}$/i.test(runtimeNodeSha256) ||
    !/^[a-f0-9]{64}$/i.test(runtimeEntrySha256) ||
    !/^[a-f0-9]{64}$/i.test(runtimeWorkerSha256) ||
    !Number.isInteger(relayPortV4) ||
    relayPortV4 < 1024 ||
    relayPortV4 > 65_535
  ) {
    throw new NativeWindowsSandboxError("installation state 版本或摘要无效。");
  }

  return {
    generationId,
    supervisorSha256,
    networkSha256,
    runtimeNodeSha256,
    runtimeEntrySha256,
    runtimeWorkerSha256,
    relayPortV4,
  };
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
  access?: SandboxNativeAccess;
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
  const leaseEpoch = Buffer.allocUnsafe(4);
  leaseEpoch.writeUInt32LE(input.access?.leaseEpoch ?? 0);
  const manifestDigest = input.access?.manifest.manifestDigest ?? "";
  const installIdentities = new Set(
    input.access?.installObjectIdentityDigests ?? [],
  );
  const roots = input.access
    ? [
        ...input.access.manifest.readRoots.map((root) => ({
          ...root,
          flags: 0,
        })),
        ...input.access.manifest.writeRoots.map((root) => ({
          ...root,
          flags: 1,
        })),
        ...input.access.manifest.gitConfigFiles.map((root) => ({
          ...root,
          flags: 2,
        })),
      ]
    : [];
  const rootCount = Buffer.allocUnsafe(4);
  rootCount.writeUInt32LE(roots.length);

  return Buffer.concat([
    header,
    framedString(input.executionInstanceId),
    framedString(input.cwd),
    framedString(input.command),
    framedString(input.privateDirectory),
    timeout,
    argumentCount,
    ...input.args.map(framedString),
    framedString(manifestDigest),
    framedString(input.access?.gitGlobalConfigPath ?? ""),
    framedString(input.access?.proxyUrl ?? ""),
    framedString(input.access?.proxyHost ?? ""),
    framedString(input.access?.proxyToken ?? ""),
    framedString(""),
    leaseEpoch,
    rootCount,
    ...roots.flatMap((root) => {
      const flags = Buffer.allocUnsafe(4);
      flags.writeUInt32LE(
        root.flags | (installIdentities.has(root.objectIdentityDigest) ? 4 : 0),
      );

      return [
        flags,
        framedString(root.path),
        framedString(root.deviceId),
        framedString(root.fileId),
        framedString(root.objectIdentityDigest),
      ];
    }),
  ]);
}

function encodeNativeAccessRevocation(roots: SandboxRevokeRoot[]) {
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32LE(REQUEST_MAGIC, 0);
  header.writeUInt32LE(REQUEST_VERSION, 4);
  header.writeUInt32LE(roots.length, 8);

  return Buffer.concat([
    header,
    ...roots.flatMap((root) => {
      const flags = Buffer.allocUnsafe(4);
      flags.writeUInt32LE(root.objectType === "file" ? 2 : 0);

      return [
        flags,
        framedString(root.path),
        framedString(root.deviceId),
        framedString(root.fileId),
        framedString(root.objectIdentityDigest),
      ];
    }),
  ]);
}

export class NativeWindowsSandboxRuntime implements SandboxRuntime {
  private paths: InstallationPaths;
  private environment: NodeJS.ProcessEnv;
  private metadata?: InstallationMetadata;
  private relay?: SandboxHttpsRelay;
  private startupRecovery?: Promise<void>;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private runSelfCheck = executeProcess,
    private log?: Logger,
    private traces?: TraceRecorder,
  ) {
    this.environment = environment;
    this.paths = installationPaths(environment);
  }

  async prepareAccess(command: SandboxCommand, workspace: SandboxWorkspace) {
    if (!this.paths.dataRoot) {
      throw new NativeWindowsSandboxError("Sandbox 数据目录不可用。");
    }

    const profileDirectory = this.environment.USERPROFILE;
    if (!profileDirectory || !path.isAbsolute(profileDirectory)) {
      throw new NativeWindowsSandboxError("宿主用户 profile 路径不可用。");
    }

    command.signal.throwIfAborted();
    const graph = await discoverGitConfigGraph({
      profileDirectory,
      workspaceRoot: workspace.root,
    });
    const projectionRoot = path.join(this.paths.dataRoot, "projections");
    const instancesRoot = path.join(this.paths.dataRoot, "instances");
    await Promise.all([
      mkdir(projectionRoot, { recursive: true }),
      mkdir(instancesRoot, { recursive: true }),
    ]);
    const directory = await mkdtemp(path.join(projectionRoot, "lease-"));
    let privateDirectory: string | undefined;
    const aggregate = path.join(directory, "global.gitconfig");
    try {
      privateDirectory = await mkdtemp(path.join(instancesRoot, "lease-"));
      await writeFile(aggregate, graph.aggregate, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      await Promise.all([
        rm(directory, { recursive: true, force: true }).catch(() => {}),
        privateDirectory
          ? rm(privateDirectory, { recursive: true, force: true }).catch(
              () => {},
            )
          : Promise.resolve(),
      ]);
      throw error;
    }

    return {
      readOnlyRoots: [directory],
      readWriteRoots: [privateDirectory],
      gitConfigFiles: [...graph.files, aggregate],
      privateDirectory,
      gitGlobalConfigPath: aggregate,
      cleanup: async () => {
        await Promise.all([
          rm(directory, { recursive: true, force: true }),
          rm(privateDirectory, { recursive: true, force: true }),
        ]);
      },
    };
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
      const [
        supervisorDigest,
        networkDigest,
        runtimeNodeDigest,
        runtimeEntryDigest,
        runtimeWorkerDigest,
      ] = await Promise.all([
        fileSha256(this.paths.supervisor),
        fileSha256(this.paths.networkManager),
        fileSha256(this.paths.runtimeNode),
        fileSha256(this.paths.runtimeEntry),
        fileSha256(this.paths.runtimeWorker),
      ]);
      if (
        supervisorDigest !== metadata.supervisorSha256.toLowerCase() ||
        networkDigest !== metadata.networkSha256.toLowerCase() ||
        runtimeNodeDigest !== metadata.runtimeNodeSha256.toLowerCase() ||
        runtimeEntryDigest !== metadata.runtimeEntrySha256.toLowerCase() ||
        runtimeWorkerDigest !== metadata.runtimeWorkerSha256.toLowerCase()
      ) {
        throw new NativeWindowsSandboxError(
          "原生二进制或 Agent Runtime 摘要与安装记录不一致。",
        );
      }

      this.metadata = metadata;
    } catch (error) {
      if (error instanceof NativeWindowsSandboxError) {
        throw error;
      }

      throw new NativeWindowsSandboxError("安装状态或原生二进制不可读。");
    }

    this.startupRecovery ??= this.drainGeneration(signal);
    await this.startupRecovery;

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

  async execute(
    command: SandboxCommand,
    _workspace: SandboxWorkspace,
    access?: SandboxNativeAccess,
  ) {
    void _workspace;
    const privateDirectory = access?.privateDirectory;
    if (!privateDirectory || !path.isAbsolute(privateDirectory)) {
      throw new NativeWindowsSandboxError(
        "执行请求缺少已授权的私有 HOME/TEMP。",
      );
    }

    let relayLease: IssuedRelayLease | undefined;
    let pushSpan: ReturnType<TraceRecorder["startSpan"]> | undefined;
    if (command.kind === "push-runner") {
      if (!command.networkHost || !access || !this.metadata) {
        throw new NativeWindowsSandboxError(
          "Push Runner 缺少已确认的网络目标。",
        );
      }

      this.relay ??= new SandboxHttpsRelay(this.metadata.relayPortV4, this.log);
      await this.relay.start();
      this.traces?.instant(
        command.taskId,
        "broker.relay_attest",
        "sandbox",
        "Sandbox broker",
        { executionInstanceId: command.executionInstanceId },
      );
      relayLease = this.relay.issueLease(
        command.networkHost,
        command.timeoutMs,
      );
      access = {
        ...access,
        proxyUrl: relayLease.proxyUrl,
        proxyHost: command.networkHost,
        proxyToken: relayLease.token,
      };
      this.traces?.instant(
        command.taskId,
        "sandbox.proxy_lease.issued",
        "sandbox",
        "Sandbox broker",
        { executionInstanceId: command.executionInstanceId },
      );
      pushSpan = this.traces?.startSpan(command.taskId, {
        name: "sandbox.push_runner",
        category: "sandbox",
        track: "Sandbox runtime",
        attributes: { executionInstanceId: command.executionInstanceId },
      });
    }

    const frame = encodeNativeSandboxRequest({
      executionInstanceId: command.executionInstanceId,
      cwd: command.cwd,
      command: command.command,
      args: command.args,
      privateDirectory,
      timeoutMs: command.timeoutMs,
      access,
    });

    try {
      const result = await this.spawnSupervisor(command, frame);
      if (pushSpan) {
        this.traces?.endSpan(pushSpan, "ok", { exitCode: result.exitCode });
        pushSpan = undefined;
      }

      return result;
    } catch (error) {
      if (pushSpan) {
        this.traces?.endSpan(
          pushSpan,
          command.signal.aborted ? "cancelled" : "error",
        );
        pushSpan = undefined;
      }

      throw error;
    } finally {
      if (relayLease) {
        this.relay?.revoke(relayLease);
        this.traces?.instant(
          command.taskId,
          "sandbox.proxy_lease.revoked",
          "sandbox",
          "Sandbox broker",
          { executionInstanceId: command.executionInstanceId },
        );
      }
    }
  }

  async revokeAccess(roots: SandboxRevokeRoot[], signal: AbortSignal) {
    if (roots.length === 0) {
      return;
    }

    const result = await executeProcess(
      this.paths.supervisor,
      ["--revoke", this.paths.state, this.paths.networkManager],
      process.cwd(),
      signal,
      20_000,
      4_096,
      () => {},
      {},
      undefined,
      encodeNativeAccessRevocation(roots),
    );
    if (
      result.exitCode !== 0 ||
      !result.output.includes("CODEATELIER_REVOKE_OK")
    ) {
      throw new NativeWindowsSandboxError("共享 ACL 撤销失败。");
    }
  }

  async drainGeneration(
    signal: AbortSignal,
    context?: { taskId: string; executionInstanceId: string },
  ) {
    const span = context
      ? this.traces?.startSpan(context.taskId, {
          name: "sandbox.account_generation.drain",
          category: "sandbox",
          track: "Sandbox runtime",
          attributes: {
            executionInstanceId: context.executionInstanceId,
          },
        })
      : undefined;
    await this.relay?.close();
    this.relay = undefined;
    const operations = [
      {
        argument: "--terminate-account-processes",
        marker: "CODEATELIER_ACCOUNT_PROCESSES_TERMINATED",
      },
      {
        argument: "--revoke-journal",
        marker: "CODEATELIER_REVOKE_JOURNAL_OK",
      },
    ];

    try {
      for (const operation of operations) {
        const result = await this.runSelfCheck(
          this.paths.supervisor,
          [operation.argument, this.paths.state, this.paths.networkManager],
          process.cwd(),
          signal,
          20_000,
          4_096,
          () => {},
          {},
        );
        if (
          result.exitCode !== 0 ||
          !result.output.includes(operation.marker)
        ) {
          throw new NativeWindowsSandboxCleanupError(
            "account generation 排空或 ACL journal 对账失败。",
          );
        }
      }

      if (span) {
        this.traces?.endSpan(span, "ok");
      }
    } catch (error) {
      if (span) {
        this.traces?.endSpan(span, signal.aborted ? "cancelled" : "error");
      }

      throw error;
    }
  }

  /** 服务启动即完成上一进程 generation 对账；失败由 Broker 保留为后续命令的安全 fallback 原因。 */
  async recoverStartup(signal: AbortSignal) {
    await this.selfCheck(signal, {
      root: this.paths.dataRoot,
      protectedPaths: [],
      protection: "direct-path",
    });
  }

  async shutdown() {
    await this.relay?.close();
    this.relay = undefined;
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
      let accessProvisioned = false;
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
          /CODEATELIER_RUNTIME_STARTED pid=(\d+) created100ns=(\d+)/g,
        )) {
          const pid = Number(match[1]);
          if (Number.isSafeInteger(pid) && pid > 0) {
            if (!accessProvisioned) {
              accessProvisioned = true;
              command.onAccessProvisioned?.();
            }

            command.onProcessStarted(pid, "runtime", match[2]);
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
        const completion = classifySupervisorClose({
          aborted: command.signal.aborted,
          timedOut,
          cleanupFailure,
          exitCode,
        });
        if (completion === "cleanup_unknown") {
          this.log?.error({
            event: "sandbox.instance_release.failed",
            module: "sandbox",
            sessionId: command.sessionId,
            taskId: command.taskId,
            executionInstanceId: command.executionInstanceId,
            category: "cleanup",
            cancellationRequested: command.signal.aborted,
          });
          reject(
            new NativeWindowsSandboxCleanupError("ACL 或 Job 清理结果未知。"),
          );
        } else if (completion === "cancelled") {
          this.log?.info({
            event: "sandbox.instance_release.completed",
            module: "sandbox",
            sessionId: command.sessionId,
            taskId: command.taskId,
            executionInstanceId: command.executionInstanceId,
            result: "cancelled",
          });
          reject(command.signal.reason ?? new Error("任务已取消"));
        } else if (completion === "timed_out") {
          reject(new Error("命令超时，Sandbox Job 已终止。"));
        } else if (completion === "security_rejected") {
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
