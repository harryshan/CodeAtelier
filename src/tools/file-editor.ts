/**
 * FileEditor 执行 ToolRunner 分流的单文件与多文件编辑，共享其审批回调和读取哈希。
 * 1. prepare 逐文件审批、核对读取版本、用 planEdits 定位原始快照并限制内存规模。
 * 2. verify 在整批审批后和每次写入前复核路径及原文，避免审批等待期间的变化被覆盖。
 * 3. commit 用同目录临时文件替换单个目标，保留权限并更新读取哈希；不提供跨文件事务。
 * 4. editOne 保持单文件 diff/异常契约；editMany 先校验全批，再记录逐文件执行状态。
 * edit_progress 经 Engine 保存到历史，写入前标 unknown、成功后标 written；断电或持久化失败
 * 仍可能留下未知结果，恢复必须检查现场，不自动回滚或重放。参数/错误的脱敏由 Engine 负责。
 */

import { readFile, writeFile, rename, unlink, chmod } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { regularFile, resolveTarget } from "./paths.js";
import { planEdits, type FileEdit } from "./edit-plan.js";

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
  mode: number;
}

type FileStatus = "not_attempted" | "unknown" | "written";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;

export class FileEditor {
  constructor(private ctx: EditorContext) {}

  private async prepare(input: FileEdit): Promise<PreparedEdit> {
    const file = await this.ctx.access(input.path);
    const info = await regularFile(file, MAX_FILE_BYTES);
    const before = await readFile(file, "utf8");
    if (
      before.includes("\0") ||
      this.ctx.readHashes.get(file) !== hash(before)
    ) {
      throw new Error("文件未读取或已变化，请重新读取后再修改。");
    }

    const after = planEdits(before, input.edits);
    if (Buffer.byteLength(after) > MAX_FILE_BYTES) {
      throw new Error("编辑后文件超过 2 MiB，请缩小修改。");
    }

    return { path: input.path, file, before, after, mode: info.mode };
  }

  private async verify(edit: PreparedEdit) {
    this.ctx.signal.throwIfAborted();
    const current = await resolveTarget(this.ctx.root, edit.path);
    if (current.path !== edit.file) {
      throw new Error("目标路径在审批或编辑期间变化。");
    }

    await regularFile(edit.file, MAX_FILE_BYTES);
    if ((await readFile(edit.file, "utf8")) !== edit.before) {
      throw new Error("文件已变化，请重新读取。");
    }
  }

  private async commit(edit: PreparedEdit) {
    const temp = edit.file + ".codeatelier-" + randomUUID() + ".tmp";
    try {
      await writeFile(temp, edit.after, { flag: "wx" });
      await chmod(temp, edit.mode);
      await this.verify(edit);
      this.ctx.signal.throwIfAborted();
      await rename(temp, edit.file);
      this.ctx.readHashes.set(edit.file, hash(edit.after));
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

  async editOne(input: FileEdit) {
    const edit = await this.prepare(input);
    await this.verify(edit);
    await this.commit(edit);

    return this.reportDiff(edit);
  }

  async editMany(inputs: FileEdit[]) {
    const batchId = randomUUID();
    const files = inputs.map((input) => ({
      path: input.path,
      status: "not_attempted" as FileStatus,
    }));
    const prepared: PreparedEdit[] = [];
    const paths = new Set<string>();
    let bytes = 0;

    try {
      for (const input of inputs) {
        const edit = await this.prepare(input);
        if (paths.has(edit.file)) {
          throw new Error("批次包含重复的真实文件路径，请合并修改。");
        }

        paths.add(edit.file);
        bytes += Buffer.byteLength(edit.before) + Buffer.byteLength(edit.after);
        if (bytes > MAX_BATCH_BYTES) {
          throw new Error("批次原文和结果合计超过 16 MiB，请拆分批次。");
        }

        prepared.push(edit);
      }

      // 所有审批完成后再次检查全批，避免第一份快照在后续审批期间失效。
      for (const edit of prepared) {
        await this.verify(edit);
      }
    } catch (error: any) {
      return { batchId, files, error: error.message };
    }

    this.ctx.emit("edit_progress", {
      batchId,
      files: files.map((file) => ({ ...file })),
    });
    for (const [index, edit] of prepared.entries()) {
      try {
        await this.verify(edit);
      } catch (error: any) {
        return { batchId, files, error: error.message };
      }

      // 先记录未知，写入后再记录成功；事件保存失败时不能继续执行下一文件。
      files[index].status = "unknown";
      this.ctx.emit("edit_progress", { batchId, ...files[index] });
      try {
        await this.commit(edit);
      } catch (error: any) {
        return { batchId, files, error: error.message };
      }

      files[index].status = "written";
      this.ctx.emit("edit_progress", { batchId, ...files[index] });
      this.reportDiff(edit);
    }

    return { batchId, files };
  }
}
