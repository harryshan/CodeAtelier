/**
 * 提供受限的 Git 状态、差异、提交和推送工具，避免把任意 Git 参数暴露给模型。
 * ToolRunner 将已通过 Zod 校验的 Git 调用转交给 GitToolRunner；它使用当前会话的工作区、
 * 审批管理器、取消信号和命令输出限制。测试可注入 GitExecutor，因此不会对真实仓库写入。
 *
 * 1. GitToolName、GitExecutor 与 GitToolContext 描述四个固定工具及其进程依赖。
 * 2. isGitTool 让 ToolRunner 将专用工具从普通命令分流；isGitExecutable 阻止通过 run_command
 *    直接调用 Git，以免绕过参数限制和审批说明。
 * 3. GitToolRunner.execute 运行只读 status/diff，或在每次提交和推送前创建不可复用的审批。
 * 4. commitPaths 在审批前后解析真实路径，拒绝工作区外、敏感及 .git 路径；commit 仅暂存并
 *    提交这些路径，禁用 hooks 与 GPG 签名，避免项目配置意外执行程序或请求凭据。
 *
 * Git 提交会修改索引和仓库元数据，push 会向已配置 upstream 进行外部写入，因此两者绝不
 * 自动批准。取消或进程中断发生在 Git 命令执行期间时，结果可能未知，恢复流程必须先检查
 * git_status/git_diff，而不能盲目重放。
 */

import path from "node:path";
import type { ApprovalManager } from "../permissions/approval-manager.js";
import type { Settings } from "../shared/types.js";
import { resolveTarget } from "./paths.js";
import { executeProcess } from "./process.js";

export type GitToolName = "git_status" | "git_diff" | "git_commit" | "git_push";

export interface GitProcessResult {
  output: string;
  exitCode: number | null;
  truncated: boolean;
}

export type GitExecutor = (
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  outputLimit: number,
  onOutput: (text: string) => void,
) => Promise<GitProcessResult>;

export interface GitToolContext {
  root: string;
  sessionId: string;
  taskId: string;
  signal: AbortSignal;
  settings: Settings;
  approvals: ApprovalManager;
  emit: (type: string, data: any) => void;
}

export function isGitTool(name: string): name is GitToolName {
  return ["git_status", "git_diff", "git_commit", "git_push"].includes(name);
}

export function isGitExecutable(command: string) {
  return /^git(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(command));
}

export class GitToolRunner {
  constructor(
    private ctx: GitToolContext,
    private executeGit: GitExecutor = (
      args,
      cwd,
      signal,
      timeoutMs,
      outputLimit,
      onOutput,
    ) =>
      executeProcess(
        "git",
        args,
        cwd,
        signal,
        timeoutMs,
        outputLimit,
        onOutput,
      ),
  ) {}

  async execute(name: GitToolName, args: any): Promise<any> {
    this.ctx.signal.throwIfAborted();

    if (name === "git_status") {
      return this.run(["status", "--short", "--branch"]);
    }

    if (name === "git_diff") {
      return {
        ...(await this.run([
          "diff",
          "--no-ext-diff",
          ...(args.staged ? ["--cached"] : []),
        ])),
        staged: !!args.staged,
      };
    }

    if (name === "git_commit") {
      return this.commit(args.message, args.paths);
    }

    return this.push();
  }

  private run(args: string[]) {
    return this.executeGit(
      args,
      this.ctx.root,
      this.ctx.signal,
      this.ctx.settings.commandTimeoutMs,
      this.ctx.settings.outputChars,
      (text) => this.ctx.emit("git_output", { text }),
    );
  }

  private async approve(tool: GitToolName, description: object) {
    const allowed = await this.ctx.approvals.request(
      {
        sessionId: this.ctx.sessionId,
        taskId: this.ctx.taskId,
        tool,
        description: JSON.stringify(description, null, 2),
      },
      this.ctx.signal,
    );

    if (!allowed) {
      throw new Error("用户拒绝 Git 操作。");
    }
  }

  private async commitPaths(inputs: string[]) {
    const paths: string[] = [];

    for (const input of inputs) {
      const target = await resolveTarget(this.ctx.root, input);
      const relative = path.relative(this.ctx.root, target.path);
      const parts = target.path.split(/[\\/]/);

      if (
        target.outside ||
        target.sensitive ||
        !relative ||
        parts.some((part) => /^\.git$/i.test(part))
      ) {
        throw new Error("Git 提交路径必须是工作区内的非敏感文件或目录。");
      }

      if (!paths.includes(relative)) {
        paths.push(relative);
      }
    }

    return paths;
  }

  private async commit(message: string, inputs: string[]) {
    const paths = await this.commitPaths(inputs);

    await this.approve("git_commit", {
      action: "git commit",
      message,
      paths,
      note: "将暂存并仅提交以上路径；不会运行 hooks 或 GPG 签名。",
    });

    // 审批等待期间路径可能被替换为链接或移到工作区外，必须再次解析。
    const checkedPaths = await this.commitPaths(inputs);
    const stage = await this.run(["add", "--", ...checkedPaths]);

    if (stage.exitCode !== 0) {
      return { paths: checkedPaths, stage, commit: null };
    }

    const commit = await this.run([
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--only",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      message,
      "--",
      ...checkedPaths,
    ]);

    return { paths: checkedPaths, stage, commit };
  }

  private async push() {
    await this.approve("git_push", {
      action: "git push",
      target: "当前分支已配置的 upstream",
      note: "此操作会向远程仓库写入；不允许指定 remote、branch、--force 或其他 Git 参数。",
    });

    return this.run(["push", "--porcelain"]);
  }
}
