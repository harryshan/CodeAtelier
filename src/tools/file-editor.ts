/**
 * FileEditor 执行 ToolRunner 分流的统一多文件编辑，共享其审批回调和读取哈希。
 * 1. prepare 逐文件审批，按 create 区分新建与已有文件：新建必须不存在；已有文件必须已读取、核对可选版本，并以 planEdits 的精确优先/唯一空白候选策略定位原始快照；某项失败不阻塞独立文件。
 * 2. verify 在预检结束和每次写入前复核路径、存在性及原文，避免审批等待期间的变化被覆盖或 create 误覆盖外部新建的文件；空白敏感扩展名仅容忍 CRLF/LF 差异。
 * 3. commit 用同目录临时文件替换单个目标，创建时先建立父目录并重新核对真实路径；已有文件保留权限，但成功修改后作废读取哈希，要求再次读取后才能继续修改；不提供跨文件事务。
 * 4. editMany 同时处理新建和已有文件条目：汇总所有逐文件失败，仍写入可安全执行的条目，并记录逐文件状态。
 * edit_progress 经 Engine 保存到历史，写入前标 unknown、成功后标 written；断电或持久化失败
 * 仍可能留下未知结果，恢复必须检查现场，不自动回滚或重放。参数/错误的脱敏由 Engine 负责。
 */

import {
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
  lstat,
  mkdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { regularFile, resolveTarget } from "./paths.js";
import {
  EditPlanError,
  planEdits,
  type EditDiagnostic,
  type FileEdit,
} from "./edit-plan.js";

interface EditorContext {
  root: string;
  signal: AbortSignal;
  access: (path: string) => Promise<string>;
  readHashes: Map<string, string>;
  emit: (type: string, data: any) => void;
}

interface PreparedEdit {
  path: string;
  file: string;
  before: string;
  after: string;
  mode?: number;
  create: boolean;
  matchModes?: string[];
}

type FileStatus = "not_attempted" | "failed" | "unknown" | "written";

interface FileResult {
  path: string;
  status: FileStatus;
  error?: string;
  diagnostic?: EditDiagnostic;
  matchModes?: string[];
}

interface PreparedFile {
  edit: PreparedEdit;
  bytes: number;
}
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const whitespaceSensitiveExtensions = new Set([
  ".make",
  ".md",
  ".mk",
  ".py",
  ".pyi",
  ".toml",
  ".yaml",
  ".yml",
]);

function allowsWhitespaceFallback(filePath: string) {
  const basename = path.basename(filePath).toLowerCase();

  return (
    basename !== "makefile" &&
    !whitespaceSensitiveExtensions.has(path.extname(basename))
  );
}

function diagnosticFor(error: unknown): EditDiagnostic | undefined {
  if (error instanceof EditPlanError) {
    return error.diagnostic;
  }

  if (
    error instanceof Error &&
    error.message.includes("文件版本与本任务读取结果不一致")
  ) {
    return {
      code: "EDIT_FILE_VERSION_MISMATCH",
      message: error.message,
      lineRange: null,
      expectedDisplay: "",
      suggestedAction:
        "重新读取当前文件并使用返回的 contentHash 重新提交编辑。",
    };
  }

  return undefined;
}

export class FileEditor {
  constructor(private ctx: EditorContext) {}

  private async prepare(input: FileEdit): Promise<PreparedEdit> {
    const file = await this.ctx.access(input.path);
    if (input.create) {
      if (input.content.includes("\0")) {
        throw new Error("新文件内容不能包含二进制 NUL 字符。");
      }

      if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) {
        throw new Error("新文件超过 2 MiB，请缩小内容。");
      }

      try {
        await lstat(file);
        throw new Error(
          "目标文件已存在；请使用 create:false 并先读取后精确编辑。",
        );
      } catch (error: any) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      return {
        path: input.path,
        file,
        before: "",
        after: input.content,
        create: true,
      };
    }

    const info = await regularFile(file, MAX_FILE_BYTES);
    const bytes = await readFile(file);
    const before = bytes.toString("utf8");
    const currentHash = hash(bytes);
    const readHash = this.ctx.readHashes.get(file);
    if (before.includes("\0") || readHash !== currentHash) {
      throw new Error("文件未读取或已变化，请重新读取后再修改。");
    }

    if (input.fileVersion !== null && input.fileVersion !== readHash) {
      throw new Error("文件版本与本任务读取结果不一致，请重新读取后再修改。");
    }

    const plan = planEdits(before, input.edits, {
      allowWhitespaceFallback: allowsWhitespaceFallback(input.path),
    });
    const after = plan.after;
    if (Buffer.byteLength(after) > MAX_FILE_BYTES) {
      throw new Error("编辑后文件超过 2 MiB，请缩小修改。");
    }

    return {
      path: input.path,
      file,
      before,
      after,
      mode: info.mode,
      create: false,
      matchModes: plan.matchModes,
    };
  }

  private async verify(edit: PreparedEdit) {
    this.ctx.signal.throwIfAborted();
    const current = await resolveTarget(this.ctx.root, edit.path);
    if (current.path !== edit.file) {
      throw new Error("目标路径在审批或编辑期间变化。");
    }

    if (edit.create) {
      try {
        await lstat(edit.file);
        throw new Error("目标文件已在创建期间出现，已拒绝覆盖。");
      } catch (error: any) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      return;
    }

    await regularFile(edit.file, MAX_FILE_BYTES);
    if ((await readFile(edit.file, "utf8")) !== edit.before) {
      throw new Error("文件已变化，请重新读取。");
    }
  }

  private async commit(edit: PreparedEdit) {
    if (edit.create) {
      await mkdir(path.dirname(edit.file), { recursive: true });
    }

    await this.verify(edit);
    const temp = edit.file + ".codeatelier-" + randomUUID() + ".tmp";
    try {
      await writeFile(temp, edit.after, { flag: "wx" });
      if (edit.mode !== undefined) {
        await chmod(temp, edit.mode);
      }

      await this.verify(edit);
      this.ctx.signal.throwIfAborted();
      await rename(temp, edit.file);
      if (edit.create) {
        this.ctx.readHashes.set(edit.file, hash(edit.after));
      } else {
        // 编辑后的真实内容虽然可由本次补丁推导，但后续补丁必须显式读取当前文件。
        this.ctx.readHashes.delete(edit.file);
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  private reportDiff(edit: PreparedEdit) {
    const diff = createTwoFilesPatch(
      edit.path,
      edit.path,
      edit.before,
      edit.after,
      "before",
      "after",
    );
    this.ctx.emit("diff", { path: edit.path, diff: diff.slice(0, 100000) });

    return { path: edit.path, changed: edit.before !== edit.after, diff };
  }

  async editMany(inputs: FileEdit[], onExecutionStart?: () => Promise<void>) {
    const batchId = randomUUID();
    const files: FileResult[] = inputs.map((input) => ({
      path: input.path,
      status: "not_attempted",
    }));
    const prepared = new Map<number, PreparedFile>();
    const paths = new Map<string, number>();
    let bytes = 0;

    const messageFor = (error: unknown) =>
      error instanceof Error ? error.message : String(error ?? "未知错误");
    const markFailure = (
      index: number,
      error: unknown,
      status: FileStatus = "failed",
    ) => {
      files[index].status = status;
      files[index].error = messageFor(error);
      files[index].diagnostic = diagnosticFor(error);
    };

    const result = (stopped?: unknown) => {
      const failures = files
        .filter((file) => file.error)
        .map((file) => `${file.path}：${file.error}`);
      const messages = failures.length
        ? [`以下文件修改失败或结果未知：${failures.join("；")}`]
        : [];
      if (stopped) {
        messages.push(`批次已停止：${messageFor(stopped)}`);
      }

      return messages.length
        ? { batchId, files, error: messages.join("；") }
        : { batchId, files };
    };

    for (const [index, input] of inputs.entries()) {
      let edit: PreparedEdit;
      try {
        edit = await this.prepare(input);
      } catch (error) {
        if (this.ctx.signal.aborted) {
          return result(error);
        }

        markFailure(index, error);
        continue;
      }

      const duplicate = paths.get(edit.file);
      if (duplicate !== undefined) {
        const error = new Error("批次包含重复的真实文件路径，请合并修改。");
        const earlier = prepared.get(duplicate);
        if (earlier) {
          bytes -= earlier.bytes;
          prepared.delete(duplicate);
        }

        markFailure(duplicate, error);
        markFailure(index, error);
        continue;
      }

      const fileBytes =
        Buffer.byteLength(edit.before) + Buffer.byteLength(edit.after);
      if (bytes + fileBytes > MAX_BATCH_BYTES) {
        markFailure(
          index,
          new Error("批次原文和结果合计超过 16 MiB，请拆分批次。"),
        );
        continue;
      }

      paths.set(edit.file, index);
      bytes += fileBytes;
      prepared.set(index, { edit, bytes: fileBytes });
    }

    // 审批可能等待很久，所以逐项复核；一项变化不能使已核实的其他文件失去写入机会。
    for (const [index, preparedFile] of prepared) {
      try {
        await this.verify(preparedFile.edit);
      } catch (error) {
        if (this.ctx.signal.aborted) {
          return result(error);
        }

        prepared.delete(index);
        markFailure(index, error);
      }
    }

    if (!prepared.size) {
      this.ctx.emit("edit_progress", {
        batchId,
        files: files.map((file) => ({ ...file })),
      });

      return result();
    }

    // 全部可写条目已完成审批和快照复核，下一步才开始记录写入耗时。
    await onExecutionStart?.();
    this.ctx.emit("edit_progress", {
      batchId,
      files: files.map((file) => ({ ...file })),
    });
    for (const [index, preparedFile] of prepared) {
      const edit = preparedFile.edit;
      try {
        await this.verify(edit);
      } catch (error) {
        if (this.ctx.signal.aborted) {
          return result(error);
        }

        markFailure(index, error);
        this.ctx.emit("edit_progress", { batchId, ...files[index] });
        continue;
      }

      // 先记录未知，写入后再记录成功；事件保存失败时不能继续执行下一文件。
      files[index].status = "unknown";
      this.ctx.emit("edit_progress", { batchId, ...files[index] });
      try {
        await this.commit(edit);
      } catch (error) {
        if (this.ctx.signal.aborted) {
          return result(error);
        }

        markFailure(index, error, "unknown");
        this.ctx.emit("edit_progress", { batchId, ...files[index] });
        continue;
      }

      files[index].status = "written";
      files[index].matchModes = edit.matchModes;
      this.ctx.emit("edit_progress", { batchId, ...files[index] });
      this.reportDiff(edit);
    }

    return result();
  }
}
