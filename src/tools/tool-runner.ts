/**
 * 执行模型提出的文件操作和命令，并在操作前完成参数、路径和审批检查。
 * Engine 为每个任务创建共享读取快照的 ToolRunner，并为 DAG 中每个节点派生带独立 callId 的输出作用域。
 *
 * 1. ignored 列出遍历时跳过的目录；ToolContext 定义依赖，readHashes 记住本任务读过的文件版本；forCall 共享该状态但隔离事件关联，任务收尾由根 runner.close 等待读取线程退出。
 * 2. currentFileHash 仅探测安全工作区文件的字节哈希，不更新读取凭证；access 解析路径并申请必要的权限；entries 限量遍历，commandGrant 为可复用命令计算指纹。
 * 3. execute 先通过 parseToolArguments 校验参数并解开 Git 的 request 包装（兼容历史扁平调用）。统一的精确编辑和显式新建文件均分流给共享读取哈希的 FileEditor，已有文件成功编辑后会作废对应哈希；Runtime 的全部 Git action 交给 Broker 宿主执行，push 额外预检审批，越界命令经 run_with_permissions adapter 审批后也在宿主执行。
 *    Skill 通过 skillExecute 读取 Broker 固定目录，不在 Runtime 扫描宿主文件或执行脚本。
 *    MCP 先经 prepareMcp 在 Broker 审批，再取得执行槽消费单次授权；ToolRunner 从不读取 MCP 配置或创建连接。
 * 4. 每个 execution instance 只读取 Broker 为该 task/instance 保存的状态；并发任务的 fallback/unknown 不会污染其它 PID、session 或 trace 记录。
 * 5. 只读分支只处理读取；目录浏览和代码搜索均由 run_command 在审批后执行。read_file 在主线程完成安全访问、类型检查和异步字节读取，再交给共享 Worker 池处理全文哈希与行扫描；可选 trace 将检查、读取及 Worker 阶段分开计时，不保存文件内容。
 *
 * 新建文件使用 edit_files 的 create:true 条目，已有文件只能用 create:false 的精确快照编辑；
 * FileEditor 会在写入前复核路径、存在性和读取版本，并以同目录临时文件替换目标。
 *
 * 用户审批期间文件仍可能变化，所以批准后也要复核。新任务及本任务内已成功修改的已有文件必须重新读文件，不能沿用旧哈希。
 */

import type { SkillAction, SkillResult } from "../skills/contracts.js";
import type { McpAction, McpResult } from "../mcp/contracts.js";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { MAX_READ_LINES, parseToolArguments } from "./registry.js";
import type { Settings } from "../shared/types.js";
import type { Approval } from "../shared/types.js";
import { resolveTarget, regularFile, sensitive, inside } from "./paths.js";
import { executeProcess, executeProcessFileBacked } from "./process.js";
import { commandShell, resolveExecutablePath } from "./command-shell.js";
import { FileEditor } from "./file-editor.js";
import { GitToolRunner, containsGitCommand, type GitRequest } from "./git.js";
import type { GitProcessResult, GitToolResult } from "./git.js";
import { ReadFileWorkerPool } from "./read-file-worker-pool.js";
import type {
  ReadFileTrace,
  ReadFileTraceStage,
} from "./read-file-worker-pool.js";
import type {
  CapabilityCommandRequest,
  CapabilityCommandResult,
} from "../sandbox/capability-request.js";
import { SandboxBroker } from "../sandbox/broker.js";
import { sandboxConfiguration } from "../sandbox/config.js";
import type {
  ExecutionInstanceMode,
  ExecutionInstanceRecord,
  SandboxStage,
  SandboxStatus,
} from "../sandbox/types.js";

const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".local",
  ".next",
]);

export interface ToolContext {
  root: string;
  sessionId: string;
  taskId: string;
  signal: AbortSignal;
  settings: Settings;
  approvals: {
    request(
      data: Omit<Approval, "id" | "repeatable">,
      signal: AbortSignal,
      grantKey?: string,
    ): Promise<boolean>;
  };
  emit: (type: string, data: any) => void;
  sandbox?: SandboxBroker;
  memory?: {
    apply(
      scope: { workspace: string; sessionId: string; taskId: string },
      request: unknown,
    ): Promise<unknown>;
  };
  skillExecute?: (
    request: SkillAction,
    signal: AbortSignal,
    toolCallId?: string,
  ) => Promise<SkillResult>;
  prepareMcp?: (
    request: McpAction,
    signal: AbortSignal,
    toolCallId?: string,
  ) => Promise<() => Promise<McpResult>>;
  /** Runtime 只提交一次 push 请求；Broker 完成 Git 预检、审批和宿主执行。 */
  gitPush?: (
    signal: AbortSignal,
    toolCallId?: string,
  ) => Promise<GitProcessResult>;
  /** Agent Runtime 的全部 Git action 通过已认证 IPC 交给 Broker 宿主执行。 */
  gitExecute?: (
    request: GitRequest,
    signal: AbortSignal,
    toolCallId?: string,
  ) => Promise<GitToolResult>;
  /** Runtime 只提交命令和理由；Broker 审批后返回取得执行槽才可消费的一次性宿主执行授权。 */
  prepareRunWithPermissions?: (
    request: CapabilityCommandRequest,
    signal: AbortSignal,
    toolCallId?: string,
  ) => Promise<() => Promise<CapabilityCommandResult>>;
  /** Agent Runtime 内的工具进程已处于任务 Job/token，不得再次调用 Broker 的逐工具 Sandbox。 */
  executionBoundary?: "broker-host" | "agent-runtime";
  /** Agent Runtime 内普通工具进程的父 execution instance，供恢复把 call 与常驻 Runtime 关联。 */
  parentExecutionInstanceId?: string;
  onSandboxStage?: (
    stage: SandboxStage,
    status: SandboxStatus,
    executionInstanceId: string,
  ) => void;
  onExecutionInstance?: (record: ExecutionInstanceRecord) => void;
}

interface ToolRunnerState {
  readHashes: Map<string, string>;
  readFileWorkers: ReadFileWorkerPool;
}

export class ToolRunner {
  private readHashes: Map<string, string>;
  private readFileWorkers: ReadFileWorkerPool;
  private git: GitToolRunner;
  private editor: FileEditor;
  private sandbox: SandboxBroker;

  constructor(
    private ctx: ToolContext,
    state: ToolRunnerState = {
      readHashes: new Map<string, string>(),
      readFileWorkers: new ReadFileWorkerPool(),
    },
  ) {
    this.readHashes = state.readHashes;
    this.readFileWorkers = state.readFileWorkers;
    this.sandbox = ctx.sandbox ?? new SandboxBroker(sandboxConfiguration());
    this.git = new GitToolRunner(
      ctx,
      (args, cwd, signal, timeoutMs, outputLimit, onOutput) =>
        this.executeProcessWithSandbox({
          command: this.resolveExecutable("git"),
          args,
          cwd,
          signal,
          timeoutMs,
          outputLimit,
          onOutput,
          environment: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_PAGER: "cat",
            PAGER: "cat",
            GIT_EDITOR: "true",
          },
        }).then((result) => ({
          output: result.output,
          exitCode: result.exitCode,
          truncated: result.truncated,
        })),
      async (spec, args, cwd, signal, timeoutMs, outputLimit, onOutput) => {
        if (this.sandbox.statusFor(this.ctx.taskId).requested) {
          const allowed = await this.ctx.approvals.request(
            {
              sessionId: this.ctx.sessionId,
              taskId: this.ctx.taskId,
              tool: "git_push",
              description: `允许单次 HTTPS push 到 ${spec.host}，目标 ${spec.refspec}，当前对象 ${spec.objectId.slice(0, 12)}。该主机可接收仓库内容，Git 配置、hook 及其子进程会在本次网络窗口内运行。`,
            },
            signal,
          );
          if (!allowed) {
            throw new Error("Sandbox Git push 审批未通过。 ");
          }
        }

        return this.executeProcessWithSandbox({
          command: this.resolveExecutable("git"),
          args,
          cwd,
          signal,
          timeoutMs,
          outputLimit,
          onOutput,
          executionKind: "push-runner",
          networkHost: spec.host,
          environment: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_PAGER: "cat",
            PAGER: "cat",
            GIT_EDITOR: "true",
          },
        }).then((result) => ({
          output: result.output,
          exitCode: result.exitCode,
          truncated: result.truncated,
        }));
      },
    );
    this.editor = new FileEditor({
      root: ctx.root,
      signal: ctx.signal,
      access: (input) => this.access(input, true),
      readHashes: this.readHashes,
      emit: ctx.emit,
    });
  }

  /** 根 runner 在任务收尾调用；派生的 call runner 与之共享同一读取池。 */
  close(): Promise<void> {
    return this.readFileWorkers.close();
  }

  /**
   * 并行图中的每个节点必须有独立输出作用域，不能复用 Engine 的可变当前 callId。
   * 子实例共享本任务读取哈希；已有文件成功编辑后，FileEditor 会作废其凭证，后继 edit_files 必须先重新读取。
   */
  forCall(callId: string) {
    const parentSkillExecute = this.ctx.skillExecute;
    const parentPrepareMcp = this.ctx.prepareMcp;
    const parentGitPush = this.ctx.gitPush;
    const parentGitExecute = this.ctx.gitExecute;
    const parentPrepareRunWithPermissions = this.ctx.prepareRunWithPermissions;

    return new ToolRunner(
      {
        ...this.ctx,
        sandbox: this.sandbox,
        skillExecute: parentSkillExecute
          ? (request, signal) => parentSkillExecute(request, signal, callId)
          : undefined,
        prepareMcp: parentPrepareMcp
          ? (request, signal) => parentPrepareMcp(request, signal, callId)
          : undefined,
        gitPush: parentGitPush
          ? (signal) => parentGitPush(signal, callId)
          : undefined,
        gitExecute: parentGitExecute
          ? (request, signal) => parentGitExecute(request, signal, callId)
          : undefined,
        prepareRunWithPermissions: parentPrepareRunWithPermissions
          ? (request, signal) =>
              parentPrepareRunWithPermissions(request, signal, callId)
          : undefined,
        emit: (type, data) => this.ctx.emit(type, { ...data, callId }),
      },
      {
        readHashes: this.readHashes,
        readFileWorkers: this.readFileWorkers,
      },
    );
  }

  private hash(value: string | Buffer) {
    return createHash("sha256").update(value).digest("hex");
  }

  private executionMode(status: SandboxStatus): ExecutionInstanceMode {
    if (
      status.mode === "non-isolated" ||
      status.mode === "host-process-fallback"
    ) {
      return "host-process";
    }

    if (status.mode !== "sandboxed") {
      return "unknown";
    }

    if (status.level === "wsl2-bubblewrap-inspect") {
      return "legacy-wsl2-inspect";
    }

    if (status.level?.startsWith("windows-sandbox-user")) {
      return "windows-sandbox-user";
    }

    return "sandbox-runtime";
  }

  /** Windows 原生 Runtime 不能依赖宿主 PATH 搜索；只把 Broker 已解析的真实程序路径交给 supervisor。 */
  private resolveExecutable(command: string) {
    return resolveExecutablePath(command);
  }

  /** run_command 与 Git 共享同一 executionInstance、fallback、取消、恢复、日志和 trace 生命周期。 */
  private async executeProcessWithSandbox(input: {
    command: string;
    args: string[];
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
    outputLimit: number;
    onOutput: (text: string) => void;
    environment?: NodeJS.ProcessEnv;
    executionKind?: "agent-runtime" | "push-runner";
    networkHost?: string;
  }) {
    if (this.ctx.executionBoundary === "agent-runtime") {
      if (input.executionKind === "push-runner") {
        throw new Error(
          "Agent Runtime 不能直接创建 Push Runner；必须经结构化 Runtime IPC 请求 Broker。",
        );
      }

      process.stderr.write(
        "CODEATELIER_AGENT_RUNTIME_STAGE command_spawn_begin\n",
      );
      const result = await executeProcessFileBacked(
        input.command,
        input.args,
        input.cwd,
        input.signal,
        input.timeoutMs,
        input.outputLimit,
        input.onOutput,
        process.env.TEMP ?? process.env.TMP ?? os.tmpdir(),
        input.environment ?? {},
        (pid) => {
          process.stderr.write(
            "CODEATELIER_AGENT_RUNTIME_STAGE command_spawned\n",
          );
          this.ctx.emit("sandboxed_tool_process", {
            pid,
            parentExecutionInstanceId: this.ctx.parentExecutionInstanceId,
          });
        },
        () =>
          process.stderr.write(
            "CODEATELIER_AGENT_RUNTIME_STAGE command_spawn_returned\n",
          ),
      );
      process.stderr.write("CODEATELIER_AGENT_RUNTIME_STAGE command_closed\n");

      return {
        ...result,
        sandbox: {
          enabled: true,
          requested: true,
          applied: true,
          mode: "sandboxed" as const,
          platform: process.platform,
          level: "windows-sandbox-user-agent-runtime",
        },
      };
    }

    const executionInstanceId = randomUUID();
    const createdAt = new Date().toISOString();
    const initialStatus = this.sandbox.statusFor(
      this.ctx.taskId,
      executionInstanceId,
    );
    let record: ExecutionInstanceRecord = {
      executionInstanceId,
      kind: input.executionKind ?? "agent-runtime",
      mode: this.executionMode(initialStatus),
      state: "created",
      createdAt,
      updatedAt: createdAt,
      sandboxRequested: initialStatus.requested,
      sandboxApplied: initialStatus.applied,
    };

    const publish = (next: Partial<ExecutionInstanceRecord>) => {
      record = {
        ...record,
        ...next,
        updatedAt: new Date().toISOString(),
      };
      this.ctx.emit("execution_instance", record);
      this.ctx.onExecutionInstance?.(record);
      this.sandbox.recordExecutionInstance(record);
    };

    const processStarted = (
      pid: number,
      pidKind: ExecutionInstanceRecord["pidKind"],
      processCreationTime100ns?: string,
    ) => {
      const status = this.sandbox.statusFor(
        this.ctx.taskId,
        executionInstanceId,
      );
      publish({
        state: "running",
        mode: this.executionMode(status),
        sandboxRequested: status.requested,
        sandboxApplied: status.applied,
        failureCategory: status.failureCategory,
        pid,
        pidKind,
        processCreationTime100ns,
      });
    };

    publish({});
    try {
      const outcome = await this.sandbox.executeCommand(
        {
          sessionId: this.ctx.sessionId,
          taskId: this.ctx.taskId,
          executionInstanceId,
          kind: input.executionKind ?? "agent-runtime",
          networkHost: input.networkHost,
          ...input,
          onProcessStarted: processStarted,
        },
        () =>
          executeProcess(
            input.command,
            input.args,
            input.cwd,
            input.signal,
            input.timeoutMs,
            input.outputLimit,
            input.onOutput,
            input.environment ?? {},
            (pid) => processStarted(pid, "host-process"),
          ),
        (stage, status) => {
          this.ctx.emit("sandbox_stage", {
            stage,
            executionInstanceId,
            ...status,
          });
          if (stage === "fallback_selected") {
            this.ctx.emit("sandbox_fallback", {
              text: `Sandbox 不可用，本任务已自动改用宿主权限继续：${status.reason ?? "未提供原因。"}`,
              executionInstanceId,
              ...status,
            });
          }

          this.ctx.onSandboxStage?.(stage, status, executionInstanceId);
        },
      );
      publish({
        state: "completed",
        mode: this.executionMode(outcome.status),
        sandboxRequested: outcome.status.requested,
        sandboxApplied: outcome.status.applied,
        failureCategory: outcome.status.failureCategory,
      });

      return { ...outcome.result, sandbox: outcome.status };
    } catch (error) {
      const status = this.sandbox.statusFor(
        this.ctx.taskId,
        executionInstanceId,
      );
      const started = record.state === "running";
      publish({
        state:
          status.mode === "unknown"
            ? "unknown"
            : input.signal.aborted
              ? "cancelled"
              : started
                ? "unknown"
                : "failed",
        mode: this.executionMode(status),
        sandboxRequested: status.requested,
        sandboxApplied: status.applied,
        failureCategory: status.failureCategory,
        sideEffectsPossible: started || status.mode === "unknown",
      });
      throw error;
    }
  }

  /** 压缩用的只读版本探测；不申请额外权限，也不更新编辑所需的读取凭证。 */
  async currentFileHash(input: string): Promise<string | undefined> {
    this.ctx.signal.throwIfAborted();
    try {
      const target = await resolveTarget(this.ctx.root, input);
      if (target.outside || target.sensitive) {
        return undefined;
      }

      await regularFile(target.path, 2 * 1024 * 1024);
      const bytes = await readFile(target.path, { signal: this.ctx.signal });
      this.ctx.signal.throwIfAborted();

      return createHash("sha256").update(bytes).digest("hex");
    } catch {
      this.ctx.signal.throwIfAborted();

      return undefined;
    }
  }

  // 先解析真实路径，再决定是否需要审批；不能只按路径字符串判断越界。
  private async access(input: string, write = false) {
    const target = await resolveTarget(this.ctx.root, input);

    if (
      write &&
      target.path.split(/[\\/]/).some((part) => /^\.git$/i.test(part))
    ) {
      throw new Error("初版不支持修改 Git 元数据。");
    }

    if (this.ctx.executionBoundary === "agent-runtime") {
      if (target.outside) {
        throw new Error(
          "目标位于 Agent Runtime 授权根之外；如需宿主权限，请使用 run_with_permissions 提交完整命令和理由供 Broker 审核。",
        );
      }

      this.ctx.signal.throwIfAborted();

      return target.path;
    }

    if (
      target.outside ||
      target.sensitive ||
      (write && path.basename(target.path).toUpperCase() === "AGENTS.MD")
    ) {
      const ok = await this.ctx.approvals.request(
        {
          sessionId: this.ctx.sessionId,
          taskId: this.ctx.taskId,
          tool: write ? "file_write" : "file_read",
          description: (write ? "写入：" : "读取：") + target.path,
        },
        this.ctx.signal,
      );

      if (!ok) {
        throw new Error("用户拒绝了文件访问。");
      }
    }

    this.ctx.signal.throwIfAborted();

    return target.path;
  }

  private async entries(root: string, max = 1500) {
    const result: string[] = [];
    let visited = 0;
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (++visited > max) {
          return;
        }

        if (ignored.has(e.name) || sensitive(e.name) || e.isSymbolicLink()) {
          continue;
        }

        const name = path.join(dir, e.name);

        if (e.isDirectory()) {
          await walk(name);
        } else if (e.isFile()) {
          result.push(name);
        }

        if (visited > max) {
          return;
        }
      }
    };

    await walk(root);

    return { files: result, truncated: visited > max };
  }

  // 会话授权绑定命令、目录和项目内容。源码变化后，旧授权不再复用。
  private async commandGrant(command: string, cwd: string) {
    const safe =
      /^(?:pnpm|npm)(?:\.cmd)?\s+(?:test|build|lint|typecheck)$/i.test(
        command.trim(),
      ) || /^node\s+--test$/i.test(command.trim());

    if (!safe || !inside(this.ctx.root, cwd)) {
      return undefined;
    }

    const { files, truncated } = await this.entries(this.ctx.root, 1000);

    if (truncated) {
      return undefined;
    }

    const hash = createHash("sha256");

    hash.update(JSON.stringify([command, cwd]));
    try {
      for (const file of files.sort()) {
        await regularFile(file, 1024 * 1024);
        hash.update(file);
        hash.update(await readFile(file));
      }
    } catch {
      return undefined;
    }

    return hash.digest("hex");
  }

  async execute(
    name: string,
    raw: unknown,
    onExecutionStart?: () => Promise<void>,
    traceReadFile?: ReadFileTrace,
  ): Promise<any> {
    this.ctx.signal.throwIfAborted();
    const args: any = parseToolArguments(name, raw);
    let executionStart: Promise<void> | undefined;
    const startExecution = async () => {
      executionStart ??= onExecutionStart?.() ?? Promise.resolve();
      await executionStart;
    };

    if (name === "skill") {
      if (!this.ctx.skillExecute) {
        throw new Error("Skill 后端不可用。");
      }

      await startExecution();

      return this.ctx.skillExecute(args.request, this.ctx.signal);
    }

    if (name === "mcp") {
      if (!this.ctx.prepareMcp) {
        throw new Error("本机 MCP adapter 不可用。");
      }

      const execute = await this.ctx.prepareMcp(args.request, this.ctx.signal);
      await startExecution();

      return execute();
    }

    if (name === "memory_apply") {
      if (!this.ctx.memory) {
        throw new Error("项目记忆服务不可用。");
      }

      await startExecution();

      return this.ctx.memory.apply(
        {
          workspace: this.ctx.root,
          sessionId: this.ctx.sessionId,
          taskId: this.ctx.taskId,
        },
        args,
      );
    }

    if (name === "edit_files") {
      return this.editor.editMany(args.files, startExecution);
    }

    if (name === "git") {
      if (this.ctx.executionBoundary === "agent-runtime") {
        if (!this.ctx.gitExecute) {
          throw new Error("Agent Runtime 未连接 Broker Git adapter。");
        }

        await startExecution();

        return this.ctx.gitExecute(args, this.ctx.signal);
      }

      if (args.action === "push" && this.ctx.gitPush) {
        await startExecution();

        return this.ctx.gitPush(this.ctx.signal);
      }

      return this.git.execute(args, startExecution);
    }

    if (name === "run_with_permissions") {
      if (
        this.ctx.executionBoundary !== "agent-runtime" ||
        !this.ctx.prepareRunWithPermissions
      ) {
        throw new Error(
          "run_with_permissions 只可由已认证的 Agent Runtime 请求。",
        );
      }

      if (containsGitCommand(args.command)) {
        throw new Error("Git 操作必须使用受限的 git 工具。");
      }

      const execute = await this.ctx.prepareRunWithPermissions(
        args,
        this.ctx.signal,
      );
      await startExecution();

      return execute();
    }

    if (name === "read_file" && args.endLine < args.startLine) {
      throw new Error("endLine 不能小于 startLine。");
    }

    if (name === "run_command") {
      if (this.ctx.executionBoundary === "agent-runtime") {
        process.stderr.write(
          "CODEATELIER_AGENT_RUNTIME_STAGE command_shell_begin\n",
        );
      }

      const hostShell = commandShell(
        process.env,
        undefined,
        process.platform,
        false,
      );
      const shell = hostShell;
      const cwd = this.ctx.root;

      if (this.ctx.executionBoundary === "agent-runtime") {
        const shellName = path.win32
          .basename(shell?.command ?? "")
          .toLowerCase();
        const shellKind =
          shellName === "pwsh.exe"
            ? "pwsh"
            : shellName === "powershell.exe"
              ? "powershell"
              : shellName === "cmd.exe"
                ? "cmd"
                : "missing";
        process.stderr.write(`CODEATELIER_AGENT_RUNTIME_SHELL ${shellKind}\n`);
      }

      if (!shell) {
        throw new Error("当前平台未找到可用的命令 shell。");
      }

      if (/^\s*(?:sudo|su|runas)(?:\s|$)/i.test(args.command)) {
        throw new Error("初版不支持提权命令。");
      }

      const allowed =
        this.ctx.executionBoundary === "agent-runtime"
          ? true
          : await this.ctx.approvals.request(
              {
                sessionId: this.ctx.sessionId,
                taskId: this.ctx.taskId,
                tool: name,
                description: JSON.stringify(
                  { command: args.command, cwd },
                  null,
                  2,
                ),
              },
              this.ctx.signal,
              await this.commandGrant(args.command, cwd),
            );

      if (!allowed) {
        throw new Error("用户拒绝执行命令。");
      }

      // 命令授权结束才开始计时；Broker 的自检和实际执行都属于本次命令，不把审批等待计入其中。
      await startExecution();

      return this.executeProcessWithSandbox({
        command: shell.command,
        args: [...shell.args, args.command],
        cwd,
        signal: this.ctx.signal,
        timeoutMs: this.ctx.settings.commandTimeoutMs,
        outputLimit: this.ctx.settings.outputChars,
        onOutput: (text) => this.ctx.emit("command_output", { text }),
      });
    }

    if (name === "read_file") {
      const measure = async <T>(
        stage: ReadFileTraceStage,
        action: () => Promise<T>,
        details?: (value: T) => { bytes: number },
      ) => {
        traceReadFile?.(stage, "started");
        try {
          const value = await action();
          traceReadFile?.(stage, "ok", details?.(value));

          return value;
        } catch (error) {
          traceReadFile?.(
            stage,
            this.ctx.signal.aborted ? "cancelled" : "error",
          );
          throw error;
        }
      };

      // 路径审批/解析发生在执行槽取得之前，不计入工具执行阶段。
      const file = await this.access(args.path);
      await startExecution();
      await measure("read_file.stat", () => regularFile(file, 2 * 1024 * 1024));
      const bytes = await measure(
        "read_file.bytes",
        () => readFile(file, { signal: this.ctx.signal }),
        (value) => ({ bytes: value.byteLength }),
      );
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            );
      // Worker 只接收已由主线程授权且读取的字节；它不能用路径绕过权限、链接或大小检查。
      const result = await this.readFileWorkers.process(
        buffer as ArrayBuffer,
        {
          startLine: args.startLine,
          endLine: args.endLine,
          maxLines: MAX_READ_LINES,
          whitespaceMode: args.whitespaceMode,
        },
        this.ctx.signal,
        traceReadFile,
      );

      // 读取凭证使用 Worker 返回的全文字节哈希，避免文本重编码掩盖版本差异。
      this.readHashes.set(file, result.contentHash);

      return { path: file, ...result };
    }

    throw new Error("未知工具");
  }
}
