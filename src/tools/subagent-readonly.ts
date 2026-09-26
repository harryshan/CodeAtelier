/*
 * 执行 subagent 唯一可用的工作区只读文件操作，供主任务所在进程的协调器响应 Worker 请求。
 *
 * 1. create 在 Worker 创建前把主 agent 声明的路径绑定到真实工作区内的现存目录。
 * 2. execute 依照 agent 层的只读协议再校验白名单名称、参数和范围，拒绝敏感路径/越界，不发起审批。
 * 3. read_file 提供有版本的分页读取；list_entries 和 search_text 使用 Node 文件 API，
 *    读取沿用主工具的文件大小和分页上限；搜索/枚举只按调用方请求限制结果数量，不额外限制扫描范围或截断文本。
 * 4. 搜索逐文件读取并检查取消；路径权限、敏感文件和链接检查保持独立，不借给子 agent 任意命令或写执行器。
 *
 * 这些是工具层限制；Worker 与主进程共享 OS 身份，不构成抵御恶意线程的文件沙箱。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { inside, regularFile, resolveTarget, sensitive } from "./paths.js";
import { MAX_READ_LINES } from "./registry.js";
import {
  subagentReadSchemas,
  type SubagentReadName,
} from "../agent/subagent-read-contract.js";

export class SubagentReadOnly {
  private constructor(
    private readonly root: string,
    private readonly scopes: string[],
    private readonly signal: AbortSignal,
  ) {}

  static async create(
    root: string,
    requestedScopes: string[],
    signal: AbortSignal,
  ) {
    const scopes: string[] = [];
    for (const requested of requestedScopes) {
      const target = await resolveTarget(root, requested);
      if (
        target.outside ||
        target.sensitive ||
        !(await lstat(target.path)).isDirectory()
      ) {
        throw new Error("subagent 只允许现存、非敏感的工作区目录范围。");
      }

      scopes.push(target.path);
    }

    return new SubagentReadOnly(root, scopes, signal);
  }

  private async allowed(input: string) {
    this.signal.throwIfAborted();
    const target = await resolveTarget(this.root, input);
    if (
      target.outside ||
      target.sensitive ||
      !this.scopes.some((scope) => inside(scope, target.path))
    ) {
      throw new Error("subagent 读取路径不在许可范围内。");
    }

    return target.path;
  }

  async execute(name: string, input: unknown) {
    if (!Object.hasOwn(subagentReadSchemas, name)) {
      throw new Error("subagent 仅允许只读工具。");
    }

    const operation = name as SubagentReadName;
    const args = subagentReadSchemas[operation].parse(input);
    const target = await this.allowed(args.path);

    if (operation === "read_file") {
      const range = args as z.infer<typeof subagentReadSchemas.read_file>;
      if (range.endLine < range.startLine) {
        throw new Error("读取起止行必须有效。");
      }

      await regularFile(target, 2 * 1024 * 1024);
      const bytes = await readFile(target, { signal: this.signal });
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const lines = bytes.toString("utf8").split(/\r?\n/);
      const requestedEndLine = Math.min(range.endLine, lines.length);
      const returnedEndLine = Math.min(
        requestedEndLine,
        range.startLine + MAX_READ_LINES - 1,
      );
      const text = lines
        .slice(range.startLine - 1, returnedEndLine)
        .map((line, index) => `${range.startLine + index}: ${line}`)
        .join("\n");

      return {
        path: path.relative(this.root, target),
        contentHash,
        totalLines: lines.length,
        returnedEndLine,
        truncated: returnedEndLine < requestedEndLine,
        hasMore: returnedEndLine < lines.length,
        nextStartLine:
          returnedEndLine < lines.length ? returnedEndLine + 1 : null,
        text,
      };
    }

    if (operation === "list_entries") {
      const limit = (args as z.infer<typeof subagentReadSchemas.list_entries>)
        .maxEntries;
      if (!(await lstat(target)).isDirectory()) {
        throw new Error("subagent 只能列出目录。");
      }

      const entries = (await readdir(target, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink() && !sensitive(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      const names = entries.slice(0, limit).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));

      return {
        path: path.relative(this.root, target),
        entries: names,
        truncated: entries.length > limit,
      };
    }

    const search = args as z.infer<typeof subagentReadSchemas.search_text>;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const files = [target];
    const pattern = search.pattern.toLowerCase();
    let examined = 0;
    while (files.length && matches.length < search.maxMatches) {
      this.signal.throwIfAborted();
      const next = files.pop()!;
      const info = await lstat(next);
      if (info.isSymbolicLink()) {
        continue;
      }

      if (info.isDirectory()) {
        const entries = await readdir(next);
        for (const entry of entries.reverse()) {
          const child = path.join(next, entry);
          try {
            await this.allowed(child);
            files.push(child);
          } catch {
            this.signal.throwIfAborted();
            // 搜索自动跳过敏感或越界路径，显式 read_file 请求仍直接报错。
          }
        }

        continue;
      }

      examined++;
      if (!info.isFile()) {
        continue;
      }

      const text = await readFile(next, {
        encoding: "utf8",
        signal: this.signal,
      });
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        this.signal.throwIfAborted();
        if (line.toLowerCase().includes(pattern)) {
          matches.push({
            path: path.relative(this.root, next),
            line: index + 1,
            text: line,
          });
          if (matches.length >= search.maxMatches) {
            break;
          }
        }
      }
    }

    return {
      matches,
      examined,
      truncated: files.length > 0 || matches.length >= search.maxMatches,
    };
  }
}
