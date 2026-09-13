/**
 * 声明模型可以调用的文件和命令工具，供 Engine 生成工具列表、ToolRunner 校验参数。
 *
 * 1. schemas 定义列目录、读文件、搜索、写文件、单文件多处精确编辑、命令和受限 Git 操作的参数。
 * 2. descriptions 向模型说明各工具的用途和限制。
 * 3. definitions 将 schema 转成 Responses API 需要的函数工具声明。
 *
 * 这里只有定义，没有执行逻辑。增加工具时，还要在 ToolRunner 中补上实现和权限检查。
 */

import { z } from "zod";

/** 单次读取的硬行数上限，避免一次工具结果占满模型上下文。 */
export const MAX_READ_LINES = 500;

/** 模型可见的工具契约；执行器负责权限检查与副作用。 */
export const schemas = {
  list_files: z.object({ path: z.string() }).strict(),
  read_file: z
    .object({
      path: z.string(),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    })
    .strict(),
  search: z.object({ query: z.string().min(1), path: z.string() }).strict(),
  write_file: z
    .object({ path: z.string(), content: z.string().max(500000) })
    .strict(),
  edit_file: z
    .object({
      path: z.string(),
      edits: z
        .array(
          z
            .object({
              oldText: z.string().min(1),
              newText: z.string().max(500000),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  run_command: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).max(100),
      cwd: z.string(),
    })
    .strict(),
  git_status: z.object({}).strict(),
  // strict 工具要求所有属性均列入 required；用 false 显式选择未暂存差异。
  git_diff: z.object({ staged: z.boolean() }).strict(),
  git_commit: z
    .object({
      message: z.string().min(1).max(500),
      paths: z.array(z.string().min(1)).min(1).max(100),
    })
    .strict(),
  git_push: z.object({}).strict(),
};

const descriptions: Record<string, string> = {
  list_files:
    "List immediate directory entries. Use paths relative to the workspace.",
  read_file: `Read text with line numbers. Read AGENTS.md and applicable nested AGENTS.md before edits. Use search to locate symbols or error text, then read a focused range around the matching line; normally request 80-200 lines and expand only when needed. Avoid repeating ranges already read. Full-file reading is for short files, project instructions, or necessary whole-file analysis. Maximum ${MAX_READ_LINES} lines per call. Results report whether more lines remain or the requested range was truncated.`,
  search:
    "Search file names and text literally (not regex), recursively. Ignores dependency and build directories.",
  write_file:
    "Create or replace a UTF-8 text file. Existing files must have been read in this task. Prefer edit_file for changes.",
  edit_file:
    "Apply 1-100 edits to one previously read UTF-8 file. Merge all known changes to this file into one call. Edits run in array order against the evolving text; each oldText must match exactly once at that stage. All edits are validated in memory before a single write; any invalid edit leaves the file unchanged. Fails if the file changed externally since reading or the last successful write. Batch independent calls for distinct files in one response.",
  run_command:
    "Execute a program with an argument array, after user approval. No shell expansion. To use a shell specify its executable and arguments explicitly. On Windows use cmd.exe /d /s /c for pnpm.cmd. Do not use direct Git commands, elevation, or destructive system operations.",
  git_status:
    "Show the current repository branch and concise working-tree status. This read-only tool runs in the session workspace.",
  git_diff:
    "Show the unstaged diff by default, or the staged diff when staged is true. This read-only tool never invokes an external diff program.",
  git_commit:
    "Stage and commit only the listed workspace paths with the supplied message, after explicit user approval. Inspect git_status and git_diff first. Do not include sensitive files or .git paths.",
  git_push:
    "Push the current branch only to its configured upstream, after explicit user approval. This tool accepts no remote, branch, force, or other Git options.",
};

export const definitions = Object.entries(schemas).map(([name, schema]) => ({
  type: "function" as const,
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(schema),
  strict: true,
}));
