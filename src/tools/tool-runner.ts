/**
 * 执行模型提出的文件操作和命令，并在操作前完成参数、路径和审批检查。
 * Engine 为每个任务创建共享读取快照的 ToolRunner，并为 DAG 中每个节点派生带独立 callId 的输出作用域。
 *
 * 1. ignored 列出遍历时跳过的目录；ToolContext 定义依赖，readHashes 记住本任务读过的文件版本；forCall 共享该状态但隔离事件关联。
 * 2. currentFileHash 仅探测安全工作区文件的字节哈希，不更新读取凭证；access 解析路径并申请必要的权限；entries 限量遍历，commandGrant 为可复用命令计算指纹。
 * 3. execute 先通过 parseToolArguments 校验参数并解开 Git 的 request 包装（兼容历史扁平调用）。它在每次调用实际开始产生工具副作用或读取前回调 Engine，因此耗时不计入审批等待；统一的精确编辑和显式新建文件均分流给共享读取哈希的 FileEditor，已有文件成功编辑后会作废对应哈希，单一专用 Git 工具分流给 GitToolRunner；普通命令只接受
 *    一条命令文本，内部选择 shell、拒绝直接 Git，再申请审批并调用 executeProcess。
 * 4. 只读分支只处理读取；目录浏览和代码搜索均由 run_command 在审批后执行。读文件按 500 行分页，返回全文字节 contentHash 供压缩比较，并在内部记录文本哈希供后续修改核对。
 *
 * 新建文件使用 edit_files 的 create:true 条目，已有文件只能用 create:false 的精确快照编辑；
 * FileEditor 会在写入前复核路径、存在性和读取版本，并以同目录临时文件替换目标。
 *
 * 用户审批期间文件仍可能变化，所以批准后也要复核。新任务及本任务内已成功修改的已有文件必须重新读文件，不能沿用旧哈希。
 */

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_READ_LINES, parseToolArguments } from "./registry.js";
import type { Settings } from "../shared/types.js";
import { ApprovalManager } from "../permissions/approval-manager.js";
import { resolveTarget, regularFile, sensitive, inside } from "./paths.js";
import { executeProcess } from "./process.js";
import { commandShell } from "./command-shell.js";
import { FileEditor } from "./file-editor.js";
import { GitToolRunner, containsGitCommand } from "./git.js";
import { SandboxBroker } from "../sandbox/broker.js";
import { sandboxConfiguration } from "../sandbox/config.js";
import type { SandboxStage, SandboxStatus } from "../sandbox/types.js";

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
  approvals: ApprovalManager;
  emit: (type: string, data: any) => void;
  sandbox?: SandboxBroker;
  onSandboxStage?: (stage: SandboxStage, status: SandboxStatus) => void;
}

interface ToolRunnerState {
  readHashes: Map<string, string>;
}

export class ToolRunner {
  private readHashes: Map<string, string>;
  private git: GitToolRunner;
  private editor: FileEditor;
  private sandbox: SandboxBroker;

  constructor(
    private ctx: ToolContext,
    state: ToolRunnerState = { readHashes: new Map<string, string>() },
  ) {
    this.readHashes = state.readHashes;
    this.sandbox = ctx.sandbox ?? new SandboxBroker(sandboxConfiguration());
    this.git = new GitToolRunner(ctx);
    this.editor = new FileEditor({
      root: ctx.root,
      signal: ctx.signal,
      access: (input) => this.access(input, true),
      readHashes: this.readHashes,
      emit: ctx.emit,
    });
  }

  /**
   * 并行图中的每个节点必须有独立输出作用域，不能复用 Engine 的可变当前 callId。
   * 子实例共享本任务读取哈希；已有文件成功编辑后，FileEditor 会作废其凭证，后继 edit_files 必须先重新读取。
   */
  forCall(callId: string) {
    return new ToolRunner(
      {
        ...this.ctx,
        sandbox: this.sandbox,
        emit: (type, data) => this.ctx.emit(type, { ...data, callId }),
      },
      { readHashes: this.readHashes },
    );
  }

  private hash(value: string | Buffer) {
    return createHash("sha256").update(value).digest("hex");
  }

  private visibleWhitespace(line: string) {
    return (
      line.replaceAll("\r", "␍").replaceAll("\t", "→").replaceAll(" ", "·") +
      "↵"
    );
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
    onExecutionStart?: () => void,
  ): Promise<any> {
    this.ctx.signal.throwIfAborted();
    const args: any = parseToolArguments(name, raw);
    let executionStarted = false;
    const startExecution = () => {
      if (!executionStarted) {
        executionStarted = true;
        onExecutionStart?.();
      }
    };

    if (name === "edit_files") {
      return this.editor.editMany(args.files, startExecution);
    }

    if (name === "git") {
      return this.git.execute(args, startExecution);
    }

    if (name === "read_file" && args.endLine < args.startLine) {
      throw new Error("endLine 不能小于 startLine。");
    }

    if (name === "run_command") {
      const shell = commandShell(
        process.env,
        undefined,
        process.platform,
        this.sandbox.status.enabled && process.platform === "win32",
      );
      const cwd = this.ctx.root;

      if (!shell) {
        throw new Error("当前平台未找到可用的命令 shell。");
      }

      if (/^\s*(?:sudo|su|runas)(?:\s|$)/i.test(args.command)) {
        throw new Error("初版不支持提权命令。");
      }

      if (containsGitCommand(args.command)) {
        throw new Error("请使用受限的 git 工具。");
      }

      const grant = await this.commandGrant(args.command, cwd);
      const allowed = await this.ctx.approvals.request(
        {
          sessionId: this.ctx.sessionId,
          taskId: this.ctx.taskId,
          tool: name,
          description: JSON.stringify({ command: args.command, cwd }, null, 2),
        },
        this.ctx.signal,
        grant,
      );

      if (!allowed) {
        throw new Error("用户拒绝执行命令。");
      }

      // 命令授权结束才开始计时；Broker 的自检和实际执行都属于本次命令，不把审批等待计入其中。
      startExecution();
      const outcome = await this.sandbox.executeCommand(
        {
          command: shell.command,
          args: [...shell.args, args.command],
          cwd,
          signal: this.ctx.signal,
          timeoutMs: this.ctx.settings.commandTimeoutMs,
          outputLimit: this.ctx.settings.outputChars,
          onOutput: (text) => this.ctx.emit("command_output", { text }),
        },
        () =>
          executeProcess(
            shell.command,
            [...shell.args, args.command],
            cwd,
            this.ctx.signal,
            this.ctx.settings.commandTimeoutMs,
            this.ctx.settings.outputChars,
            (text) => this.ctx.emit("command_output", { text }),
          ),
        (stage, status) => {
          this.ctx.emit("sandbox_stage", { stage, ...status });
          this.ctx.onSandboxStage?.(stage, status);
        },
      );

      return { ...outcome.result, sandbox: outcome.status };
    }

    if (name === "read_file") {
      const file = await this.access(args.path);
      startExecution();
      await regularFile(file, 2 * 1024 * 1024);
      const bytes = await readFile(file);
      const text = bytes.toString("utf8");

      if (text.includes("\0")) {
        throw new Error("不支持二进制文件");
      }

      // 读取凭证使用返回给模型的全文字节哈希，避免文本重编码掩盖版本差异。
      this.readHashes.set(file, this.hash(bytes));
      const lines = text.split("\n");
      // 区分文件自然结束和行数上限，模型才能安全地按 nextStartLine 继续读取。
      const requestedEndLine = Math.min(args.endLine, lines.length);
      const returnedEndLine = Math.min(
        requestedEndLine,
        args.startLine + MAX_READ_LINES - 1,
      );
      const truncated = returnedEndLine < requestedEndLine;
      const hasMore = returnedEndLine < lines.length;

      return {
        path: file,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        totalLines: lines.length,
        returnedEndLine,
        truncated,
        hasMore,
        nextStartLine: hasMore ? returnedEndLine + 1 : null,
        text: lines
          .slice(args.startLine - 1, returnedEndLine)
          .map((line, index) => `${args.startLine + index}: ${line}`)
          .join("\n"),
        visibleText: args.whitespaceMode
          ? lines
              .slice(args.startLine - 1, returnedEndLine)
              .map(
                (line, index) =>
                  `${args.startLine + index}: ${this.visibleWhitespace(line)}`,
              )
              .join("\n")
          : undefined,
      };
    }

    throw new Error("未知工具");
  }
}
