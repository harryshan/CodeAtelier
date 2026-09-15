/**
 * 声明模型可以调用的文件和命令工具，供 Engine 生成工具列表、ToolRunner 校验参数。
 *
 * 1. schemas 定义列目录、读文件、搜索、写文件、统一的多文件快照精确编辑、命令和单一受限 Git 操作的参数。
 * 2. gitRequestSchema 用 request 包裹各 action 的普通联合，适配模型 strict schema；parseToolArguments 同时兼容历史扁平参数。
 * 3. descriptions 向模型说明各工具的用途和限制。
 * 4. definitions 将 schema 转成 Responses API 需要的函数工具声明。
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

/** 模型函数根节点必须是 object；嵌套普通 union 输出 anyOf，避免 discriminatedUnion 的 oneOf。 */
export const gitRequestSchema = z
  .object({ request: z.union(schemas.git.options) })
  .strict();

/** 历史扁平调用仍走原校验；新包装也必须严格验证，不能丢弃多余字段。 */
export function parseToolArguments(name: string, raw: unknown) {
  if (name === "git" && raw && typeof raw === "object" && "request" in raw) {
    return gitRequestSchema.parse(raw).request;
  }

  const schema = schemas[name as keyof typeof schemas];
  if (!schema) {
    throw new Error("未知工具");
  }

  return schema.parse(raw);
}

const descriptions: Record<string, string> = {
  list_files:
    "List immediate directory entries. Use paths relative to the workspace.",
  read_file: `Read text with line numbers. Read AGENTS.md and applicable nested AGENTS.md before edits. Use search to locate symbols or error text, then read a focused range around the matching line; normally request 80-200 lines and expand only when needed. Avoid repeating ranges already read. Full-file reading is for short files, project instructions, or necessary whole-file analysis. Maximum ${MAX_READ_LINES} lines per call. Results report whether more lines remain or the requested range was truncated.`,
  search:
    "Search file names and text literally (not regex), recursively. Ignores dependency and build directories.",
  write_file:
    "Create or replace a UTF-8 text file. Existing files must have been read in this task. Prefer edit_files for changes.",
  edit_files:
    "Edit 1-20 distinct previously read files in one call; use one files entry for a single-file change. Each entry accepts 1-100 non-overlapping edits located in the ORIGINAL snapshot, never text produced by another edit. Supply startLine/endLine as a pair of 1-based inclusive lines, or both null for unique exact-text matching. With lines, search ONLY within those lines (including the last line ending): oldText must match exactly once wholly inside that range and may be a substring of a line or span multiple lines. Preserve exact whitespace and line endings; do not include read_file line-number prefixes. No fuzzy matching or fallback outside the range. Validate permissions, versions and all edits before any write. Files write sequentially, NOT as a cross-file transaction. On failure inspect per-file statuses and current contents; never blindly replay the batch. Merge all changes to the same real path in one entry. Existing files only; use write_file to create files.",
  run_command:
    "Execute one command string in the session workspace after user approval. Provide the command to run directly, for example `pnpm test`; never wrap it in `pwsh -Command`, `powershell -Command`, `cmd /c`, `sh -c`, or another terminal invocation. CodeAtelier selects the platform shell, fixed noninteractive arguments, and workspace directory internally. When a complete compound command can be approved up front, put sequential commands, pipelines, and safe independent checks into this one command whenever it reduces tool round trips; do not add artificial output separators. Split calls only when a prior result is needed to construct the next command or request further approval. Command output disables colors and removes terminal control sequences. Do not use direct Git commands, elevation, or destructive system operations.",
  git: "Put the action and its fields inside the request object, e.g. {request:{action:status}}. Perform one safe Git action in the session workspace. Actions: status; diff (explicit staged, paths, contextLines); log (revision, paths, limit); show (revision and explicit paths); branch; add (paths); commit (message and paths); push. This tool automatically validates that the workspace is the repository root, permits only safe paths/revisions and a configured HTTPS/SSH upstream, and disables hooks, GPG signing, external diff/text conversion and interactive prompts. Use it proactively for Git work; do not invoke Git through run_command. It accepts no arbitrary subcommand, option, remote, branch target, force, reset, clean, checkout, merge, rebase, tag, stash, clone, or PR operation. Inspect status/diff/log before writes and do not replay an interrupted add, commit, or push without rechecking.",
};

export const definitions = Object.entries(schemas).map(([name, schema]) => ({
  type: "function" as const,
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(name === "git" ? gitRequestSchema : schema),
  strict: true,
}));
