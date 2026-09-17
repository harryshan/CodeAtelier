/**
 * 声明模型可以调用的文件和命令工具，供 Engine 生成工具列表、ToolRunner 校验参数。
 *
 * 1. schemas 定义读文件、统一的多文件快照编辑（含显式新建文件）、命令和单一受限 Git 操作的参数；目录浏览和代码搜索均由 run_command 执行。
 * 2. gitRequestSchema 用 request 包裹各 action 的普通联合，适配模型 strict schema；parseToolArguments 同时兼容历史扁平参数。
 * 3. scheduledParameters 为新模型调用增加 execution（节点 ID 和依赖）信封；parseScheduledToolArguments 解开并严格校验它。
 * 4. descriptions 向模型说明各工具的用途、限制和 DAG 参数约定。
 * 5. definitions 将带调度信封的 schema 转成 Responses API 需要的函数工具声明。
 *
 * 这里只有定义，没有执行逻辑。增加工具时，还要在 ToolRunner 中补上实现和权限检查。
 */

import { z } from "zod";

/** 单次读取的硬行数上限，避免一次工具结果占满模型上下文。 */
export const MAX_READ_LINES = 500;

/** null 表示不用行号；default 兼容本地旧调用，模型 strict schema 仍要求显式字段。 */
const textEditSchema = z
  .object({
    oldText: z.string().min(1),
    newText: z.string().max(500000),
    startLine: z.number().int().min(1).nullable().default(null),
    endLine: z.number().int().min(1).nullable().default(null),
  })
  .strict();

/** create 明确区分新建和已有文件编辑，避免新建意外覆盖已有路径。 */
const fileEditSchema = z.union([
  z
    .object({
      path: z.string().min(1),
      create: z.literal(true),
      content: z.string().max(500000),
    })
    .strict(),
  z
    .object({
      path: z.string().min(1),
      create: z.literal(false),
      fileVersion: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .default(null),
      edits: z.array(textEditSchema).min(1).max(100),
    })
    .strict(),
]);

/** 模型可见的工具契约；执行器负责权限检查与副作用。 */
export const schemas = {
  read_file: z
    .object({
      path: z.string(),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
      whitespaceMode: z.boolean().default(false),
    })
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

const executionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    dependsOn: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/))
      .max(19),
  })
  .strict();

/** 每个原生 Responses function_call 都带执行元数据；arguments 保持工具自身的参数契约。 */
export function scheduledParameters(schema: z.ZodType) {
  return z.object({ execution: executionSchema, arguments: schema }).strict();
}

/**
 * 解开模型调用的调度信封。没有信封的旧模拟响应仍按无依赖节点兼容，避免历史测试或
 * 已完成调用的展示格式影响新执行；新模型定义始终要求 execution 与 arguments。
 */
export function parseScheduledToolArguments(
  name: string,
  raw: unknown,
  fallbackId: string,
) {
  if (raw && typeof raw === "object" && "execution" in raw) {
    const schema = schemas[name as keyof typeof schemas];
    if (!schema) {
      throw new Error("未知工具");
    }

    const parsed = scheduledParameters(
      name === "git" ? gitRequestSchema : schema,
    ).parse(raw);

    return { execution: parsed.execution, arguments: parsed.arguments };
  }

  return {
    execution: { id: fallbackId, dependsOn: [] },
    arguments: parseToolArguments(name, raw),
  };
}

const descriptions: Record<string, string> = {
  read_file: `Read text with line numbers. Set whitespaceMode:true when diagnosing whitespace-sensitive edits: the normal text remains copyable and visibleText marks spaces (·), tabs (→), CR (␍), and line endings (↵). Read AGENTS.md and applicable nested AGENTS.md before edits. Use run_command with an environment-detected search command to locate symbols or error text, then read a focused range around the matching line; normally request 80-200 lines and expand only when needed. Avoid repeating ranges already read. Full-file reading is for short files, project instructions, or necessary whole-file analysis. Maximum ${MAX_READ_LINES} lines per call. Results report whether more lines remain or the requested range was truncated, plus a contentHash version for edits.`,
  edit_files:
    "Create or edit 1-20 distinct files in one call. Whenever arguments are already known and modifications do not conflict or depend on other tool results, collect all files for the same logical change in this one call rather than splitting calls by file. For a new file use {path, create:true, content}; creation fails if that path already exists. For an existing file use {path, create:false, fileVersion, edits}; read it in this task first and copy its contentHash as fileVersion (legacy null is accepted only for old calls). After a successful existing-file edit, read that file again before editing it again. Provide 1-100 non-overlapping edits located in the ORIGINAL snapshot, never text produced by another edit. Each edit has oldText/newText and startLine/endLine. Default startLine/endLine to null and choose the shortest oldText unique in the entire file; use a narrow 1-based inclusive line range to disambiguate repeated text. A supplied range is a hard boundary. Exact matching runs first, then unique CRLF/LF-equivalent matching for every text file; only ordinary files allow broader unique whitespace-normalized matching. Line-ending matching keeps the matched source's uniform line-ending style in newText, using the file style when the match has no newline; no fallback rewrites whitespace outside the match. Ambiguous candidates and stale versions are rejected with structured diagnostics; do not replay them blindly. Files write sequentially, NOT as a cross-file transaction. The result lists every failed path and error together; inspect per-file statuses and current contents. Merge all changes to the same real path in one entry.",
  run_command:
    "Execute one command string in the session workspace after user approval. Use this tool for repository directory listings and searches: follow the environment-detected, performance-ordered command list in the task instructions, prefer its first suitable command, and combine multiple keywords into one multi-pattern search when supported. Provide the command to run directly, for example `pnpm test`; never wrap it in `pwsh -Command`, `powershell -Command`, `cmd /c`, `sh -c`, or another terminal invocation. CodeAtelier selects the platform shell, fixed noninteractive arguments, and workspace directory internally. A complete compound command may combine known sequential commands or pipelines; for independent checks or a check after a known edit, prefer separate calls in the same DAG response with the required dependencies. Do not add artificial output separators. Use another model response only when a prior result is needed to construct the next command or decide whether to run it. Command output disables colors and removes terminal control sequences. Do not use direct Git commands, elevation, or destructive system operations.",
  git: "Put the action and its fields inside the request object, e.g. {request:{action:status}}. Perform one safe Git action in the session workspace. Actions: status; diff (explicit staged, paths, contextLines); log (revision, paths, limit); show (revision and explicit paths); branch; add (paths); commit (message and paths); push. When the current context already contains the complete edit process and relevant verification, do not casually request a full diff with empty paths: use the known changed paths and minimal context unless reconciling unknown/external changes or performing a necessary final repository-wide review. Full diff output has a fixed context limit and may be truncated. This tool automatically validates that the workspace is the repository root, permits only safe paths/revisions and a configured HTTPS/SSH upstream, and disables hooks, GPG signing, external diff/text conversion and interactive prompts. Use it proactively for Git work; do not invoke Git through run_command. It accepts no arbitrary subcommand, option, remote, branch target, force, reset, clean, checkout, merge, rebase, tag, stash, clone, or PR operation. Inspect status/diff/log before writes and do not replay an interrupted add, commit, or push without rechecking.",
};

export const definitions = Object.entries(schemas).map(([name, schema]) => ({
  type: "function" as const,
  name,
  description:
    descriptions[name] +
    " Each call must use {execution:{id,dependsOn},arguments:{...}}. id is unique within this response; dependsOn lists call ids that must succeed before this call starts. Include all calls with known arguments in this response, including dependent calls such as an edit followed by a known check. Dependencies control order and success gating only: another tool result cannot fill these arguments in the same response.",
  parameters: z.toJSONSchema(
    scheduledParameters(name === "git" ? gitRequestSchema : schema),
  ),
  strict: true,
}));
