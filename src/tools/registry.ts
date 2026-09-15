/**
 * 声明模型可以调用的文件和命令工具，供 Engine 生成工具列表、ToolRunner 校验参数。
 *
 * 1. schemas 定义列目录、读文件、搜索、写文件、单文件/多文件快照精确编辑、命令和单一受限 Git 操作的参数。
 * 2. descriptions 向模型说明各工具的用途和限制。
 * 3. definitions 将 schema 转成 Responses API 需要的函数工具声明。
 *
 * 这里只有定义，没有执行逻辑。增加工具时，还要在 ToolRunner 中补上实现和权限检查。
 */

import { z } from "zod";

/** 单次读取的硬行数上限，避免一次工具结果占满模型上下文。 */
export const MAX_READ_LINES = 500;

/** null 表示不用行号；default 兼容本地旧调用，模型 strict schema 仍要求显式字段。 */
const fileEditSchema = z
  .object({
    path: z.string().min(1),
    edits: z
      .array(
        z
          .object({
            oldText: z.string().min(1),
            newText: z.string().max(500000),
            startLine: z.number().int().min(1).nullable().default(null),
            endLine: z.number().int().min(1).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

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
  edit_file: fileEditSchema,
  edit_files: z
    .object({ files: z.array(fileEditSchema).min(1).max(20) })
    .strict(),
  run_command: z
    .object({ command: z.string().trim().min(1).max(100000) })
    .strict(),
  git: z.discriminatedUnion("action", [
    z.object({ action: z.literal("status") }).strict(),
    z
      .object({
        action: z.literal("diff"),
        staged: z.boolean(),
        paths: z.array(z.string().min(1).max(1024)).max(100),
        contextLines: z.number().int().min(0).max(100),
      })
      .strict(),
    z
      .object({
        action: z.literal("log"),
        revision: z.string().min(1).max(200),
        paths: z.array(z.string().min(1).max(1024)).max(100),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    z
      .object({
        action: z.literal("show"),
        revision: z.string().min(1).max(200),
        paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
      })
      .strict(),
    z.object({ action: z.literal("branch") }).strict(),
    z
      .object({
        action: z.literal("add"),
        paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
      })
      .strict(),
    z
      .object({
        action: z.literal("commit"),
        message: z.string().trim().min(1).max(500),
        paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
      })
      .strict(),
    z.object({ action: z.literal("push") }).strict(),
  ]),
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
    "Apply 1-100 non-overlapping edits to one previously read file, all located in the ORIGINAL snapshot. Never target text produced by another edit. Supply startLine/endLine as a pair of 1-based inclusive lines, or both null for unique exact-text matching. With lines, search ONLY within those lines (including the last line ending): oldText must match exactly once wholly inside that range and may be a substring of a line or span multiple lines. Replace only that match. Preserve exact whitespace and line endings; do not include read_file line-number prefixes. No fuzzy matching or fallback outside the range. All edits validate before writing. Use edit_files for a logical change spanning multiple files.",
  edit_files:
    "Edit 1-20 distinct previously read files in one call. Each entry uses edit_file semantics: all ranges refer to that file's ORIGINAL snapshot; startLine/endLine are both integers or both null. Validate permissions, versions and all edits before any write. Files write sequentially, NOT as a cross-file transaction. On failure inspect per-file statuses and current contents; never blindly replay the batch. Merge all changes to the same real path in one entry. Existing files only; use write_file to create files.",
  run_command:
    "Execute one command string in the session workspace after user approval. Provide only command: CodeAtelier selects the platform shell, fixed noninteractive arguments, and workspace directory internally. When a complete compound command can be approved up front, put sequential commands, pipelines, and safe independent checks into this one command whenever it reduces tool round trips; do not add artificial output separators. Split calls only when a prior result is needed to construct the next command or request further approval. Command output disables colors and removes terminal control sequences. Do not use direct Git commands, elevation, or destructive system operations.",
  git: "Perform one safe Git action in the session workspace. Actions: status; diff (explicit staged, paths, contextLines); log (revision, paths, limit); show (revision and explicit paths); branch; add (paths); commit (message and paths); push. This tool automatically validates that the workspace is the repository root, permits only safe paths/revisions and a configured HTTPS/SSH upstream, and disables hooks, GPG signing, external diff/text conversion and interactive prompts. Use it proactively for Git work; do not invoke Git through run_command. It accepts no arbitrary subcommand, option, remote, branch target, force, reset, clean, checkout, merge, rebase, tag, stash, clone, or PR operation. Inspect status/diff/log before writes and do not replay an interrupted add, commit, or push without rechecking.",
};

export const definitions = Object.entries(schemas).map(([name, schema]) => ({
  type: "function" as const,
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(schema),
  strict: true,
}));
