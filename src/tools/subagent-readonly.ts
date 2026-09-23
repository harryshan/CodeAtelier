/*
 * 执行 subagent 唯一可用的工作区只读文件操作，供主任务所在进程的协调器响应 Worker 请求。
 *
 * 1. create 在 Worker 创建前把主 agent 声明的路径绑定到真实工作区内的现存目录。
 * 2. execute 先按正向白名单校验名称、参数和范围，拒绝敏感路径/越界，不发起审批。
 * 3. read_file 提供有版本的分页读取；list_entries 和 search_text 使用 Node 文件 API，
 *    上限限制文件数、字节数与输出，绝不把任意命令、Git 或写执行器借给子 agent。
 *
 * 这些是工具层限制；Worker 与主进程共享 OS 身份，不构成抵御恶意线程的文件沙箱。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { inside, regularFile, resolveTarget, sensitive } from "./paths.js";
import { scheduledParameters } from "./registry.js";

const schema = {
  read_file: z
    .object({
      path: z.string().min(1),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    })
    .strict(),
  list_entries: z
    .object({
      path: z.string().min(1),
      maxEntries: z.number().int().min(1).max(100),
    })
    .strict(),
  search_text: z
    .object({
      path: z.string().min(1),
      pattern: z.string().min(1).max(120),
      maxMatches: z.number().int().min(1).max(100),
    })
    .strict(),
};

export const subagentReadDefinitions = Object.entries(schema).map(
  ([name, parameters]) => ({
    type: "function" as const,
    name,
    description: `Read-only workspace ${name}; no shell, edits, Git, network, memory or approval capabilities.`,
    parameters: z.toJSONSchema(scheduledParameters(parameters)),
    strict: true,
  }),
);

export type SubagentReadName = keyof typeof schema;

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
    if (!(name in schema)) {
      throw new Error("subagent 仅允许只读工具。");
    }

    const operation = name as SubagentReadName;
    const args = schema[operation].parse(input);
    const target = await this.allowed(args.path);

    if (operation === "read_file") {
      const range = args as z.infer<typeof schema.read_file>;
      if (
        range.endLine < range.startLine ||
        range.endLine - range.startLine >= 500
      ) {
        throw new Error("subagent 读取最多 500 行且起止行必须有效。");
      }

      await regularFile(target, 2 * 1024 * 1024);
      const bytes = await readFile(target, { signal: this.signal });
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const lines = bytes.toString("utf8").split(/\r?\n/);
      const text = lines
        .slice(range.startLine - 1, range.endLine)
        .map((line, index) => `${range.startLine + index}: ${line}`)
        .join("\n");

      return {
        path: path.relative(this.root, target),
        contentHash,
        totalLines: lines.length,
        text: text.slice(0, 32_000),
      };
    }

    if (operation === "list_entries") {
      const limit = (args as z.infer<typeof schema.list_entries>).maxEntries;
      if (!(await lstat(target)).isDirectory()) {
        throw new Error("subagent 只能列出目录。");
      }

      const names = (await readdir(target, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink() && !sensitive(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, limit)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));

      return { path: path.relative(this.root, target), entries: names };
    }

    const search = args as z.infer<typeof schema.search_text>;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const files = [{ path: target, depth: 0 }];
    let examined = 0;
    let bytesRead = 0;
    while (
      files.length &&
      examined < 200 &&
      matches.length < search.maxMatches
    ) {
      this.signal.throwIfAborted();
      const next = files.shift()!;
      if (next.depth > 6) {
        continue;
      }

      const info = await lstat(next.path);
      if (info.isSymbolicLink()) {
        continue;
      }

      if (info.isDirectory()) {
        const entries = await readdir(next.path);
        for (const entry of entries.slice(0, 300)) {
          const child = path.join(next.path, entry);
          try {
            await this.allowed(child);
            files.push({ path: child, depth: next.depth + 1 });
          } catch {
            // 搜索自动跳过敏感或越界路径，显式 read_file 请求仍直接报错。
          }
        }

        continue;
      }

      examined++;
      if (
        !info.isFile() ||
        info.size > 256 * 1024 ||
        bytesRead + info.size > 4 * 1024 * 1024
      ) {
        continue;
      }

      const text = await readFile(next.path, {
        encoding: "utf8",
        signal: this.signal,
      });
      bytesRead += info.size;
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.toLowerCase().includes(search.pattern.toLowerCase())) {
          matches.push({
            path: path.relative(this.root, next.path),
            line: index + 1,
            text: line.slice(0, 240),
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
      truncated:
        files.length > 0 ||
        examined >= 200 ||
        matches.length >= search.maxMatches,
    };
  }
}
