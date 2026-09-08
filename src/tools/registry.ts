import { z } from "zod";

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
      oldText: z.string().min(1),
      newText: z.string().max(500000),
    })
    .strict(),
  run_command: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).max(100),
      cwd: z.string(),
    })
    .strict(),
};

const descriptions: Record<string, string> = {
  list_files:
    "List immediate directory entries. Use paths relative to the workspace.",
  read_file:
    "Read text with line numbers. Read AGENTS.md and applicable nested AGENTS.md before edits. Maximum 2000 lines.",
  search:
    "Search file names and text literally (not regex), recursively. Ignores dependency and build directories.",
  write_file:
    "Create or replace a UTF-8 text file. Existing files must have been read in this task. Prefer edit_file for changes.",
  edit_file:
    "Replace exactly one occurrence of oldText in a previously read UTF-8 file. Fails if the file changed since reading.",
  run_command:
    "Execute a program with an argument array, after user approval. No shell expansion. To use a shell specify its executable and arguments explicitly. On Windows use cmd.exe /d /s /c for pnpm.cmd. Do not use Git mutations, elevation, or destructive system operations.",
};

export const definitions = Object.entries(schemas).map(([name, schema]) => ({
  type: "function" as const,
  name,
  description: descriptions[name],
  parameters: z.toJSONSchema(schema),
  strict: true,
}));
