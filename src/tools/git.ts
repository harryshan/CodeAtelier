/**
 * 提供单一、参数受限的 Git 工具，供 ToolRunner 在不经普通命令审批的情况下执行常见仓库操作。
 * ToolRunner 先用 Zod 校验 `git` 的 action 专属参数，再把当前会话工作区、取消信号和输出限制交给
 * GitToolRunner；测试可注入 GitExecutor，因而不需要创建真实提交或远程连接。
 *
 * 1. GitRequest 描述 status、diff、log、show、branch、add、commit 和 push 的互斥参数组合；
 *    isGitExecutable 和 containsGitCommand 继续阻止 run_command 绕过本模块。
 * 2. execute 在每项动作前通知 Engine 开始计时，验证会话工作区恰好是 Git worktree 根目录，再分派固定参数的子命令。
 * 3. workspacePaths 解析真实路径、拒绝敏感/.git/绝对或选项式路径；受控 dotenv 模板需通过内容校验，目录递归检查后代。
 * 4. diff/show/log 仅接受安全 revision 和受校验路径；完整 diff 使用独立硬输出上限，模板相关 diff/show 在输出前再次扫描，避免泄露历史凭据。
 * 5. push 从当前分支的 upstream 配置推导唯一 remote 与 refs/heads 目标，拒绝本地、ext 等不安全 URL，
 *    commit 禁用 hooks/GPG，push 保留仓库 hook 语义；两者都禁用交互终端、分页和外部 diff/textconv。
 *
 * Git 仍以当前用户权限访问可信工作区，应用层校验不是操作系统沙箱。add、commit 与 push 由用户授权
 * 自动执行；取消或进程中断时结果可能未知，恢复前必须通过 git 的 status/diff/log 重新核实，不能重放。
 */

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../shared/types.js";
import { pathRisk, resolveTarget, type PathRisk } from "./paths.js";
import {
  assertNoCredentialMaterial,
  validateDotenvTemplate,
} from "./git-file-safety.js";
import { executeProcess } from "./process.js";

export type GitAction =
  "status" | "diff" | "log" | "show" | "branch" | "add" | "commit" | "push";

export type GitRequest =
  | { action: "status" }
  | { action: "diff"; staged: boolean; paths: string[]; contextLines: number }
  | { action: "log"; revision: string; paths: string[]; limit: number }
  | { action: "show"; revision: string; paths: string[] }
  | { action: "branch" }
  | { action: "add"; paths: string[] }
  | { action: "commit"; message: string; paths: string[] }
  | { action: "push" };

export interface GitProcessResult {
  output: string;
  exitCode: number | null;
  truncated: boolean;
}

/** 完整补丁很容易挤占下一轮模型输入；diff 不随用户的通用命令输出上限无限增大。 */
export const MAX_GIT_DIFF_OUTPUT_CHARS = 12000;

export type GitExecutor = (
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  outputLimit: number,
  onOutput: (text: string) => void,
) => Promise<GitProcessResult>;

export interface GitPushSpec {
  remote: string;
  remoteUrl: string;
  host: string;
  refspec: string;
  objectId: string;
}

export type GitPushExecutor = (
  spec: GitPushSpec,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  outputLimit: number,
  onOutput: (text: string) => void,
) => Promise<GitProcessResult>;

interface WorkspacePaths {
  paths: string[];
  hasDotenvTemplate: boolean;
}

export interface GitToolContext {
  root: string;
  sessionId: string;
  taskId: string;
  signal: AbortSignal;
  settings: Settings;
  emit: (type: string, data: any) => void;
}

function samePath(first: string, second: string) {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLocaleLowerCase() : value;

  return normalize(path.resolve(first)) === normalize(path.resolve(second));
}

function safeRevision(value: string) {
  return (
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/")
  );
}

function safePushUrl(value: string) {
  const remote = value.trim();

  try {
    const url = new URL(remote);

    if (url.protocol === "https:") {
      return Boolean(url.hostname) && !url.username && !url.password;
    }

    if (url.protocol === "ssh:") {
      return Boolean(url.hostname) && !url.password;
    }
  } catch {
    // Git 的 SCP 风格 SSH 地址不是 WHATWG URL，继续按保守规则检查。
  }

  return /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(remote);
}

export function isGitExecutable(command: string) {
  return /^git(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(command));
}

/** shell 命令无法可靠静态解析；保守拒绝独立 git 程序名，避免普通工具绕过受限 action。 */
export function containsGitCommand(command: string) {
  return /(^|[^a-z0-9_.-])git(?:\.exe|\.cmd|\.bat)?(?=$|[^a-z0-9_.-])/i.test(
    command,
  );
}

export class GitToolRunner {
  private repositoryRoot: string | undefined;

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
        {
          // 保留已配置的非交互凭据，但绝不让模型任务卡在终端认证、分页或编辑器中。
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          GIT_EDITOR: "true",
        },
      ),
    private executePush?: GitPushExecutor,
  ) {}

  async execute(
    request: GitRequest,
    onExecutionStart?: () => void,
  ): Promise<any> {
    this.ctx.signal.throwIfAborted();
    onExecutionStart?.();
    await this.ensureRepository();

    switch (request.action) {
      case "status":
        return this.run([
          "--no-optional-locks",
          "status",
          "--short",
          "--branch",
          "--untracked-files=normal",
        ]);
      case "diff":
        return this.diff(request);
      case "log":
        return this.log(request);
      case "show":
        return this.show(request);
      case "branch":
        return this.run([
          "--no-optional-locks",
          "branch",
          "--no-color",
          "--format=%(HEAD) %(refname:short) %(upstream:short)",
        ]);
      case "add":
        return this.add(request.paths);
      case "commit":
        return this.commit(request.message, request.paths);
      case "push":
        return this.push();
    }
  }

  private run(
    args: string[],
    emit = true,
    outputLimit = this.ctx.settings.outputChars,
  ) {
    return this.executeGit(
      args,
      this.ctx.root,
      this.ctx.signal,
      this.ctx.settings.commandTimeoutMs,
      outputLimit,
      emit ? (text) => this.ctx.emit("git_output", { text }) : () => {},
    );
  }

  private async ensureRepository() {
    if (this.repositoryRoot) {
      return;
    }

    const result = await this.run(["rev-parse", "--show-toplevel"], false);
    const repositoryRoot = result.output.trim();

    if (result.exitCode !== 0 || !repositoryRoot) {
      throw new Error("当前会话工作区不是可用的 Git 工作树。");
    }

    if (!samePath(repositoryRoot, this.ctx.root)) {
      throw new Error("Git 仓库根目录必须与当前会话工作区完全一致。");
    }

    this.repositoryRoot = repositoryRoot;
  }

  private async workspacePaths(inputs: string[]): Promise<WorkspacePaths> {
    const checkedPaths: string[] = [];
    let hasDotenvTemplate = false;

    for (const input of inputs) {
      if (
        !input.trim() ||
        path.isAbsolute(input) ||
        input.startsWith("-") ||
        input.includes("\0")
      ) {
        throw new Error("Git 路径必须是工作区内的相对路径，且不能是选项。");
      }

      const target = await resolveTarget(this.ctx.root, input);
      const relative = path.relative(this.ctx.root, target.path);

      hasDotenvTemplate =
        (await this.checkGitPath(
          target.path,
          target.outside,
          target.sensitive,
        )) || hasDotenvTemplate;
      hasDotenvTemplate =
        (await this.checkDirectory(target.path)) || hasDotenvTemplate;
      const gitPath = relative.split(path.sep).join("/");

      if (!checkedPaths.includes(gitPath)) {
        checkedPaths.push(gitPath);
      }
    }

    return { paths: checkedPaths, hasDotenvTemplate };
  }

  private async checkGitPath(
    target: string,
    outside: boolean,
    isSensitive: boolean,
  ): Promise<boolean> {
    const relative = path.relative(this.ctx.root, target);
    const parts = target.split(/[\\/]/);
    const risk: PathRisk = pathRisk(target);

    if (
      outside ||
      !relative ||
      parts.some((part) => /^\.git$/i.test(part)) ||
      risk === "hard-sensitive" ||
      risk === "dotenv-runtime" ||
      (isSensitive && risk !== "dotenv-template")
    ) {
      throw new Error("Git 路径必须是工作区内的非敏感文件或目录。");
    }

    if (risk === "dotenv-template") {
      await validateDotenvTemplate(target);

      return true;
    }

    return false;
  }

  private async checkDirectory(directory: string): Promise<boolean> {
    let hasDotenvTemplate = false;
    let info;

    try {
      info = await lstat(directory);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return hasDotenvTemplate;
      }

      throw error;
    }

    if (!info.isDirectory() || info.isSymbolicLink()) {
      return hasDotenvTemplate;
    }

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const target = await resolveTarget(this.ctx.root, child);

      hasDotenvTemplate =
        (await this.checkGitPath(
          target.path,
          target.outside,
          target.sensitive,
        )) || hasDotenvTemplate;

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        hasDotenvTemplate =
          (await this.checkDirectory(target.path)) || hasDotenvTemplate;
      }
    }

    return hasDotenvTemplate;
  }

  private async runTemplateChecked(
    args: string[],
    hasDotenvTemplate: boolean,
    outputLimit?: number,
  ) {
    const result = await this.run(args, !hasDotenvTemplate, outputLimit);

    if (hasDotenvTemplate) {
      if (result.truncated) {
        throw new Error(
          "受控 dotenv 模板的输出超过安全上限，已拒绝显示不完整内容。",
        );
      }

      assertNoCredentialMaterial(result.output);
      if (result.output) {
        this.ctx.emit("git_output", { text: result.output });
      }
    }

    return result;
  }

  private async diff(request: Extract<GitRequest, { action: "diff" }>) {
    const workspacePaths = request.paths.length
      ? await this.workspacePaths(request.paths)
      : await this.changedPaths(request.staged);
    const result = await this.runTemplateChecked(
      [
        "--no-optional-locks",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        `--unified=${request.contextLines}`,
        ...(request.staged ? ["--cached"] : []),
        "--",
        ...workspacePaths.paths,
      ],
      workspacePaths.hasDotenvTemplate,
      Math.min(this.ctx.settings.outputChars, MAX_GIT_DIFF_OUTPUT_CHARS),
    );

    return { ...result, staged: request.staged, paths: workspacePaths.paths };
  }

  private async changedPaths(staged: boolean): Promise<WorkspacePaths> {
    const result = await this.run(
      [
        "--no-optional-locks",
        "diff",
        "--name-only",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        ...(staged ? ["--cached"] : []),
        "--",
      ],
      false,
    );

    if (result.exitCode !== 0 || result.truncated) {
      throw new Error("无法完整核对 Git 差异路径，已拒绝显示全量差异。");
    }

    const paths = result.output.split("\0").filter(Boolean);

    return this.workspacePaths(paths);
  }

  private async log(request: Extract<GitRequest, { action: "log" }>) {
    this.assertRevision(request.revision);
    const workspacePaths = await this.workspacePaths(request.paths);

    return this.run([
      "--no-optional-locks",
      "log",
      "--no-color",
      "--no-decorate",
      "--format=%H%x09%h%x09%s",
      `--max-count=${request.limit}`,
      request.revision,
      "--",
      ...workspacePaths.paths,
    ]);
  }

  private async show(request: Extract<GitRequest, { action: "show" }>) {
    this.assertRevision(request.revision);
    const workspacePaths = await this.workspacePaths(request.paths);

    return this.runTemplateChecked(
      [
        "--no-optional-locks",
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--format=fuller",
        request.revision,
        "--",
        ...workspacePaths.paths,
      ],
      workspacePaths.hasDotenvTemplate,
    );
  }

  private assertRevision(revision: string) {
    if (!safeRevision(revision)) {
      throw new Error("Git revision 只能包含受限的分支、标签或提交哈希字符。");
    }
  }

  private async add(inputs: string[]) {
    const workspacePaths = await this.workspacePaths(inputs);
    const add = await this.run(["add", "--", ...workspacePaths.paths]);

    return { paths: workspacePaths.paths, add };
  }

  private async commit(message: string, inputs: string[]) {
    const workspacePaths = await this.workspacePaths(inputs);
    const stage = await this.run(["add", "--", ...workspacePaths.paths]);

    if (stage.exitCode !== 0) {
      return { paths: workspacePaths.paths, stage, commit: null };
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
      ...workspacePaths.paths,
    ]);

    return { paths: workspacePaths.paths, stage, commit };
  }

  private async push() {
    const branch = await this.valueFromGit([
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const remote = await this.valueFromGit([
      "config",
      "--get",
      `branch.${branch}.remote`,
    ]);
    const merge = await this.valueFromGit([
      "config",
      "--get",
      `branch.${branch}.merge`,
    ]);
    const remoteUrl = await this.valueFromGit([
      "remote",
      "get-url",
      "--push",
      remote,
    ]);
    const objectId = await this.valueFromGit(["rev-parse", "HEAD"]);

    if (!safeRevision(branch) || !/^[A-Za-z0-9._-]+$/.test(remote)) {
      throw new Error(
        "当前 Git 分支或 upstream remote 名称不安全，已拒绝推送。",
      );
    }

    if (
      !merge.startsWith("refs/heads/") ||
      !safeRevision(merge.slice("refs/heads/".length))
    ) {
      throw new Error("当前分支没有安全的 refs/heads upstream，已拒绝推送。");
    }

    if (!safePushUrl(remoteUrl)) {
      throw new Error(
        "upstream remote URL 仅允许 HTTPS、SSH 或 SCP 风格 SSH 地址。",
      );
    }

    if (!/^[a-f0-9]{40,64}$/i.test(objectId)) {
      throw new Error("无法确定待推送提交的对象 ID。");
    }

    const args = ["push", "--porcelain", remote, `HEAD:${merge}`];
    if (this.executePush) {
      const url = new URL(remoteUrl);
      if (url.protocol !== "https:") {
        throw new Error("Sandbox Push Runner 首版只支持 HTTPS remote。");
      }

      return this.executePush(
        {
          remote,
          remoteUrl,
          host: url.hostname.toLocaleLowerCase(),
          refspec: `HEAD:${merge}`,
          objectId: objectId.toLocaleLowerCase(),
        },
        args,
        this.ctx.root,
        this.ctx.signal,
        this.ctx.settings.commandTimeoutMs,
        this.ctx.settings.outputChars,
        (text) => this.ctx.emit("git_output", { text }),
      );
    }

    return this.run(args);
  }

  private async valueFromGit(args: string[]) {
    const result = await this.run(args, false);
    const value = result.output.trim();

    if (
      result.exitCode !== 0 ||
      !value ||
      result.truncated ||
      value.includes("\n")
    ) {
      throw new Error("无法确定当前分支的 Git upstream 配置。");
    }

    return value;
  }
}
