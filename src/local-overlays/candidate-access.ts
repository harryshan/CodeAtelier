/**
 * 一次性候选卷的持久根身份，供 CandidateValidator 和启动 Sandbox ACL 撤销使用。
 * 1. save 在 Runtime 启动前独占写入、flush 有界记录，只读取四个目录身份，不扫描源码。
 * 2. read 核对普通单链接文件、大小、打开身份及严格格式；记录不代表验证成功或任务排空。
 * 3. recover 核对存储/来源/控制身份和原生旧 owner 退出，再仅挂载根 ACL；撤销结束必卸载。
 * 4. remove 仅删除匹配的记录；正常候选清理调用，未知执行及启动恢复保留全部私有证据。
 * 本模块不更新发布日志、不解除任务/来源锁；调用方负责生命周期 trace 和先排空 Sandbox 账户。
 */
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { directoryIdentity } from "../worktrees/git.js";
import type { LocalOverlayBackend } from "./backend.js";
import { withLocalInspection } from "./inspection-lease.js";

const schema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("candidate-access"),
    id: z.uuid(),
    source: z.string().min(1).max(32768),
    sourceIdentity: z.string().min(1).max(256),
    storageIdentity: z.string().min(1).max(256),
    controlIdentity: z.string().min(1).max(256),
    workspaceIdentity: z.string().min(1).max(256),
  })
  .strict();
type CandidateAccessRecord = z.infer<typeof schema>;
const maxBytes = 65536;

export class CandidateAccessStore {
  constructor(private readonly directory: string) {}

  private file(id: string) {
    return path.join(this.directory, `${z.uuid().parse(id)}.access.json`);
  }

  async save(id: string, source: string, workspace: string) {
    const record = schema.parse({
      version: 1,
      purpose: "candidate-access",
      id,
      source: path.resolve(source),
      sourceIdentity: await directoryIdentity(source),
      storageIdentity: await directoryIdentity(this.directory),
      controlIdentity: await directoryIdentity(
        path.join(this.directory, z.uuid().parse(id)),
      ),
      workspaceIdentity: await directoryIdentity(workspace),
    });
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    if (bytes.length > maxBytes) {
      throw new Error("候选恢复记录超过大小限制。");
    }

    const handle = await open(this.file(id), "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    return record;
  }

  private async read(id: string) {
    const file = this.file(id);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > maxBytes
    ) {
      throw new Error("候选恢复记录类型或大小无效。");
    }

    const handle = await open(file, "r");
    let record: CandidateAccessRecord;
    try {
      const current = await handle.stat();
      if (
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.size !== info.size
      ) {
        throw new Error("候选恢复记录身份改变。");
      }

      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== info.size) {
        throw new Error("候选恢复记录读取不完整。");
      }

      record = schema.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
    } finally {
      await handle.close();
    }

    if (record.id !== id || !path.isAbsolute(record.source)) {
      throw new Error("候选恢复记录归属无效。");
    }

    return record;
  }

  async remove(record: CandidateAccessRecord) {
    if (JSON.stringify(await this.read(record.id)) !== JSON.stringify(record)) {
      throw new Error("候选恢复记录已变化，保留现场。");
    }

    await unlink(this.file(record.id));
  }

  async recover(
    id: string,
    backend: LocalOverlayBackend,
    signal: AbortSignal,
    operation: () => Promise<void>,
  ) {
    signal.throwIfAborted();
    const record = await this.read(id);
    const control = path.join(this.directory, id);
    if (
      (await directoryIdentity(this.directory)) !== record.storageIdentity ||
      (await directoryIdentity(record.source)) !== record.sourceIdentity ||
      (await directoryIdentity(control)) !== record.controlIdentity ||
      !backend.recoverAccess
    ) {
      throw new Error("候选 ACL 恢复目录身份或后端不匹配。");
    }

    await withLocalInspection(control, signal, async () => {});
    if (JSON.stringify(await this.read(id)) !== JSON.stringify(record)) {
      throw new Error("候选 ACL 恢复记录已变化。");
    }

    // The native root-only mount rechecks owner exit under its exclusive lease.
    // It cannot turn this retained record into a successful validation receipt.
    const mount = await backend.recoverAccess(
      id,
      record.source,
      control,
      signal,
    );
    try {
      if ((await mount.identity()) !== record.workspaceIdentity) {
        throw new Error("候选 ACL 恢复卷身份不匹配。");
      }

      signal.throwIfAborted();
      await operation();
    } finally {
      await mount.close();
    }
  }
}
