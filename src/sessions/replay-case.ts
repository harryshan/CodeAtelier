/**
 * 定义任务 replay case 的本地捕获、导出、模型响应回放和隔离文件场景物化。
 * Engine 在任务运行时通过 captureModelProvider 逐次保存模型请求/结果，Store 保存工具调用的完整脱敏结果；
 * 手动导出命令或改进测试随后读取 TaskReplayCase。输入是历史的模型、工具与事件材料，输出是可校验的
 * transcript 和（仅在完整读取版本足够时）全新的隔离工作区，绝不在原工作区执行或写入。
 *
 * 1. TaskReplayCapture/TaskReplayCase 描述捕获版本、模型交换、工具调用和任务历史；旧会话可形成 legacy
 *    case，但不会被标为 transcript 可重放。
 * 2. captureModelProvider 在调用模型前持久化请求，并在成功或失败后补齐结果，进程中断会留下明确的未完成项。
 * 3. RecordedModelProvider 为测试提供严格的请求匹配和确定性响应；它只重放模型响应，不执行工具副作用。
 * 4. analyzeReplayWorkspace 从 read_file 的完整、哈希一致读取版本拼接文件；materializeReplayWorkspace 只向
 *    不存在的新目录写入这些材料，缺失、局部读取、冲突或路径不安全时拒绝物化。
 *
 * replay case 属于受保护的本地开发材料，可能含用户 prompt、源码、命令和工具输出；虽然 API key 会在
 * Engine 写入前脱敏，它仍不得上传、提交或当作不可信输入的权限依据。它不包含进程、网络、Git 索引或
 * 未被读取文件的快照，因此只有 analysis 明确 complete 的文件集合才能用于真实 edit_files 场景回放。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ModelProvider,
  ModelResult,
  ModelRunOptions,
} from "../providers/model-provider.js";
import type {
  Event,
  Session,
  Settings,
  Task,
  TaskStatus,
} from "../shared/types.js";

export const REPLAY_CASE_VERSION = 1;

type ReplaySettings = Pick<
  Settings,
  | "model"
  | "reasoningEffort"
  | "auxiliaryModel"
  | "auxiliaryReasoningEffort"
  | "maxSteps"
  | "commandTimeoutMs"
  | "requestTimeoutMs"
  | "idleTimeoutMs"
  | "maxOutputTokens"
  | "contextChars"
  | "outputChars"
> &
  Partial<Pick<Settings, "maxContextTokens">>;

export interface RecordedModelExchange {
  id: string;
  purpose:
    | "task"
    | "auxiliary"
    | "approval"
    | "compaction"
    | "title"
    | "subagent"
    | "tool_review";
  step?: number;
  attempt?: number;
  input: any[];
  instructions: string;
  tools: any[];
  options?: ModelRunOptions;
  response?: ModelResult;
  error?: { name: string; message: string; code?: string; status?: number };
}

export interface RecordedToolCall {
  callId: string;
  nodeId: string;
  name: string;
  arguments: unknown;
  dependsOn: string[];
  batchId: string;
  result?: unknown;
}

export interface TaskReplayCapture {
  schemaVersion: typeof REPLAY_CASE_VERSION;
  capturedAt: string;
  platform: string;
  settings: ReplaySettings;
  modelExchanges: RecordedModelExchange[];
  tools: RecordedToolCall[];
  finalizedAt?: string;
  status?: TaskStatus;
}

export interface TaskReplayCase {
  schemaVersion: typeof REPLAY_CASE_VERSION;
  source: "captured" | "legacy";
  session: Session;
  task: Task;
  capture?: TaskReplayCapture;
  tools: RecordedToolCall[];
  events: Event[];
}

export interface ReplayCaptureSink {
  startModelExchange(entry: RecordedModelExchange): string | Promise<string>;
  finishModelExchange(
    id: string,
    outcome: Pick<RecordedModelExchange, "response" | "error">,
  ): void | Promise<void>;
}

function copy<T>(value: T): T {
  // 可选请求选项通常为 undefined，JSON.stringify(undefined) 不能再被 JSON.parse。
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function errorRecord(error: unknown): RecordedModelExchange["error"] {
  const value = error as { code?: unknown; status?: unknown };

  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
  };
}

/** 将提供者包装为可审计的模型交互记录；请求先写入，避免中断后误称它从未发生。 */
export function captureModelProvider(
  provider: ModelProvider,
  sink: ReplayCaptureSink,
  details: () => Pick<RecordedModelExchange, "purpose" | "step" | "attempt">,
): ModelProvider {
  return {
    getCapabilities: provider.getCapabilities?.bind(provider),
    async run(input, instructions, tools, signal, onDelta, options) {
      const id = randomUUID();
      await sink.startModelExchange({
        id,
        ...details(),
        input: copy(input),
        instructions,
        tools: copy(tools),
        options: copy(options),
      });

      try {
        const response = await provider.run(
          input,
          instructions,
          tools,
          signal,
          onDelta,
          options,
        );
        await sink.finishModelExchange(id, { response: copy(response) });

        return response;
      } catch (error) {
        await sink.finishModelExchange(id, { error: errorRecord(error) });
        throw error;
      }
    },
  };
}

/** 检查捕获是否拥有每一次请求的终态；不以任务 completed 猜测中断中的模型请求结果。 */
export function hasCompleteTranscript(capture: TaskReplayCapture | undefined) {
  return Boolean(
    capture?.finalizedAt &&
    capture.status &&
    capture.modelExchanges.every((exchange) =>
      Boolean(exchange.response || exchange.error),
    ) &&
    capture.tools.every((tool) => tool.result !== undefined),
  );
}

export class ReplayMismatchError extends Error {}

/** 供隔离测试使用的确定性模型；调用参数改变时立即报错而不是静默返回旧响应。 */
export class RecordedModelProvider implements ModelProvider {
  private index = 0;

  constructor(private capture: TaskReplayCapture) {
    if (!hasCompleteTranscript(capture)) {
      throw new Error("Replay case 的模型交互未完整捕获，不能回放。");
    }
  }

  async run(
    input: any[],
    instructions: string,
    tools: any[],
    _signal: AbortSignal,
    _onDelta: (text: string) => void,
    options?: ModelRunOptions,
  ) {
    const expected = this.capture.modelExchanges[this.index++];
    if (!expected) {
      throw new ReplayMismatchError("Replay case 已耗尽，收到额外模型请求。");
    }

    if (
      !isDeepStrictEqual(expected.input, input) ||
      expected.instructions !== instructions ||
      !isDeepStrictEqual(expected.tools, tools) ||
      !isDeepStrictEqual(expected.options, options)
    ) {
      throw new ReplayMismatchError(
        `第 ${this.index} 次模型请求与 replay case 不一致。`,
      );
    }

    if (expected.error) {
      throw new Error(expected.error.message);
    }

    return copy(expected.response!);
  }

  assertConsumed() {
    if (this.index !== this.capture.modelExchanges.length) {
      throw new ReplayMismatchError("Replay case 尚有未消费的模型响应。");
    }
  }
}

interface FilePiece {
  path: string;
  contentHash: string;
  totalLines: number;
  startLine: number;
  lines: string[];
}

interface ReconstructedFile {
  path: string;
  content: string;
  contentHash: string;
}

export interface ReplayWorkspaceAnalysis {
  complete: boolean;
  files: ReconstructedFile[];
  missingPaths: string[];
  reasons: string[];
}

function toolArguments(tool: RecordedToolCall) {
  const value = tool.arguments as {
    path?: unknown;
    files?: unknown;
    startLine?: unknown;
  };

  return value && typeof value === "object" ? value : {};
}

function safeRelativePath(value: unknown) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    return undefined;
  }

  const normalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return undefined;
  }

  return normalized;
}

function readPieces(caseFile: TaskReplayCase) {
  const pieces: FilePiece[] = [];

  for (const tool of caseFile.tools) {
    if (tool.name !== "read_file" || !tool.result) {
      continue;
    }

    const args = toolArguments(tool);
    const result = tool.result as Record<string, unknown>;
    const relativePath = safeRelativePath(args.path);
    const startLine = args.startLine;
    const totalLines = result.totalLines;
    const returnedEndLine = result.returnedEndLine;
    if (
      !relativePath ||
      typeof startLine !== "number" ||
      typeof totalLines !== "number" ||
      typeof returnedEndLine !== "number" ||
      typeof result.contentHash !== "string" ||
      typeof result.text !== "string" ||
      startLine < 1 ||
      returnedEndLine < startLine - 1
    ) {
      continue;
    }

    const numbered = result.text ? result.text.split("\n") : [];
    const lines: string[] = [];
    let valid = numbered.length === returnedEndLine - startLine + 1;
    for (const [index, row] of numbered.entries()) {
      const prefix = `${startLine + index}: `;
      if (!row.startsWith(prefix)) {
        valid = false;
        break;
      }

      lines.push(row.slice(prefix.length));
    }

    if (valid) {
      pieces.push({
        path: relativePath,
        contentHash: result.contentHash,
        totalLines,
        startLine,
        lines,
      });
    }
  }

  return pieces;
}

function reconstructedFiles(caseFile: TaskReplayCase) {
  const grouped = new Map<string, FilePiece[]>();
  for (const piece of readPieces(caseFile)) {
    const key = `${piece.path}\u0000${piece.contentHash}`;
    grouped.set(key, [...(grouped.get(key) ?? []), piece]);
  }

  const files = new Map<string, ReconstructedFile>();
  for (const [key, pieces] of grouped) {
    const [relativePath, contentHash] = key.split("\u0000");
    const totalLines = pieces[0].totalLines;
    if (pieces.some((piece) => piece.totalLines !== totalLines)) {
      continue;
    }

    const lines = new Array<string | undefined>(totalLines);
    let conflict = false;
    for (const piece of pieces) {
      for (const [index, line] of piece.lines.entries()) {
        const lineIndex = piece.startLine - 1 + index;
        if (
          lineIndex >= totalLines ||
          (lines[lineIndex] !== undefined && lines[lineIndex] !== line)
        ) {
          conflict = true;
          break;
        }

        lines[lineIndex] = line;
      }
    }

    if (conflict || lines.some((line) => line === undefined)) {
      continue;
    }

    const content = lines.join("\n");
    const actualHash = createHash("sha256")
      .update(Buffer.from(content))
      .digest("hex");
    if (actualHash === contentHash) {
      files.set(relativePath, { path: relativePath, content, contentHash });
    }
  }

  return files;
}

/** 只将 edit_files 的既有文件视为真实文件回放前置条件；新建成功项的初态是已知不存在。 */
export function analyzeReplayWorkspace(
  caseFile: TaskReplayCase,
): ReplayWorkspaceAnalysis {
  const available = reconstructedFiles(caseFile);
  const required = new Set<string>();
  const reasons: string[] = [];

  for (const tool of caseFile.tools) {
    if (tool.name !== "edit_files") {
      continue;
    }

    const files = toolArguments(tool).files;
    if (!Array.isArray(files)) {
      reasons.push("edit_files 参数缺失，不能确定文件前置状态。");
      continue;
    }

    for (const file of files as Array<Record<string, unknown>>) {
      const relativePath = safeRelativePath(file.path);
      if (!relativePath) {
        reasons.push("edit_files 含不安全或缺失的相对路径。");
        continue;
      }

      if (file.create === false) {
        required.add(relativePath);
        if (
          typeof file.fileVersion === "string" &&
          available.get(relativePath)?.contentHash !== file.fileVersion
        ) {
          reasons.push(
            `${relativePath} 的读取版本与 edit_files fileVersion 不一致。`,
          );
        }
      } else if (file.create === true && tool.result) {
        const resultFiles = (tool.result as { files?: unknown }).files;
        const result = Array.isArray(resultFiles)
          ? resultFiles.find((entry: any) => entry?.path === file.path)
          : undefined;
        if (result?.status !== "written") {
          reasons.push(`${relativePath} 的新建前文件状态未完整捕获。`);
        }
      }
    }
  }

  const missingPaths = [...required].filter((file) => !available.has(file));
  for (const file of missingPaths) {
    reasons.push(`${file} 没有可验证的完整 read_file 版本。`);
  }

  return {
    complete: reasons.length === 0,
    files: [...available.values()].filter((file) => required.has(file.path)),
    missingPaths,
    reasons,
  };
}

/** 只向不存在的新目录写入可验证的既有文件版本，避免 replay 覆盖用户真实工作区。 */
export async function materializeReplayWorkspace(
  caseFile: TaskReplayCase,
  directory: string,
) {
  const analysis = analyzeReplayWorkspace(caseFile);
  if (!analysis.complete) {
    throw new Error(`Replay 文件场景不完整：${analysis.reasons.join("；")}`);
  }

  await mkdir(directory);
  for (const file of analysis.files) {
    const destination = path.join(directory, ...file.path.split("/"));
    if (!insideDirectory(directory, destination)) {
      throw new Error("Replay 文件路径越出隔离目录。");
    }

    await mkdir(path.dirname(destination), { recursive: true });

    await writeFile(destination, file.content, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return analysis;
}

function insideDirectory(root: string, target: string) {
  const relative = path.relative(root, target);

  return (
    relative &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

/** 导出必须显式指定一个此前不存在的文件，避免意外覆盖包含敏感历史的既有 case。 */
export async function writeReplayCase(file: string, caseFile: TaskReplayCase) {
  await writeFile(file, JSON.stringify(caseFile, null, 2), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export function replaySettings(settings: Settings): ReplaySettings {
  const {
    model,
    reasoningEffort,
    auxiliaryModel,
    auxiliaryReasoningEffort,
    maxSteps,
    commandTimeoutMs,
    requestTimeoutMs,
    idleTimeoutMs,
    maxOutputTokens,
    maxContextTokens,
    contextChars,
    outputChars,
  } = settings;

  return {
    model,
    reasoningEffort,
    auxiliaryModel,
    auxiliaryReasoningEffort,
    maxSteps,
    commandTimeoutMs,
    requestTimeoutMs,
    idleTimeoutMs,
    maxOutputTokens,
    maxContextTokens,
    contextChars,
    outputChars,
  };
}
