/**
 * 将按工作区隔离的项目记忆保存为平台数据目录中的 JSONL 快照，只读写该格式。
 * ProjectMemoryService 是唯一调用方；它提供校验逐条版本的纯转换函数，本模块完成真实路径哈希、读取、互斥和原子替换。
 *
 * 1. identity 解析真实工作区，再从其 SHA-256 推导不暴露路径的文件名。
 * 2. readStored/readCurrent 严格读取 JSONL，缺失时返回空文档；load 不写盘，不探测其他格式或修复坏文件。
 * 3. update 按 JSONL 目标串行，转换函数对最新文档逐条校验；无关条目的新变化保留在完整快照中。
 * 4. publish 写出并 flush 临时快照，文件哈希仅检测提交期间竞争；明确未提交时才重算，最多进行四轮生成/发布尝试。
 *    转换函数必须无外部副作用；已提交、未知结果或 I/O 失败绝不重放。持续竞争安全失败。
 * 5. 已有 JSONL 用 rename 替换，首次建立用 link 防覆盖；原子发布仍不消除外部程序最终检查后的竞态。
 *
 * 本模块从不访问用户工作区内容，也不执行命令；写入范围固定为 Config 的平台数据目录 memories 子目录。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  MAX_MEMORY_FILE_BYTES,
  MEMORY_SCHEMA_VERSION,
  type MemoryDocument,
} from "./types.js";
import { parseMemoryJsonl, serializeMemoryJsonl } from "./jsonl.js";

const locks = new Map<string, Promise<void>>();

export interface StoredMemoryDocument {
  document: MemoryDocument;
  version: string | null;
  projectKey: string;
  filePath: string;
}

interface MemoryFileIdentity {
  canonicalWorkspace: string;
  projectKey: string;
  filePath: string;
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withFileLock<T>(filePath: string, operation: () => Promise<T>) {
  const previous = locks.get(filePath) ?? Promise.resolve();
  let release: () => void = () => {};

  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous.then(() => current);
  locks.set(filePath, queued);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (locks.get(filePath) === queued) {
      locks.delete(filePath);
    }
  }
}

export class MemoryFileStore {
  constructor(private readonly directory: string) {}

  private async identity(workspace: string) {
    const canonicalWorkspace = await realpath(workspace);
    const projectKey = createHash("sha256")
      .update(canonicalWorkspace)
      .digest("hex");
    const filePath = path.join(
      this.directory,
      "memories",
      `${projectKey}.jsonl`,
    );

    return { canonicalWorkspace, projectKey, filePath };
  }

  private emptyDocument(projectKey: string, workspace: string): MemoryDocument {
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      projectKey,
      workspace,
      enabled: true,
      updatedAt: new Date().toISOString(),
      entries: [],
    };
  }

  private async readStored(
    projectKey: string,
    workspace: string,
    filePath: string,
  ): Promise<StoredMemoryDocument | null> {
    try {
      const file = await readFile(filePath);
      if (file.byteLength > MAX_MEMORY_FILE_BYTES) {
        throw new Error("项目记忆文件超过 512 KiB 限制。");
      }

      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(file);
      const document = parseMemoryJsonl(text);
      if (
        document.projectKey !== projectKey ||
        document.workspace !== workspace
      ) {
        throw new Error("项目记忆文件与当前真实工作区不匹配。");
      }

      return { document, version: hash(file), projectKey, filePath };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private async readCurrent(
    identity: MemoryFileIdentity,
  ): Promise<StoredMemoryDocument> {
    const current = await this.readStored(
      identity.projectKey,
      identity.canonicalWorkspace,
      identity.filePath,
    );

    return (
      current ?? {
        document: this.emptyDocument(
          identity.projectKey,
          identity.canonicalWorkspace,
        ),
        version: null,
        projectKey: identity.projectKey,
        filePath: identity.filePath,
      }
    );
  }

  async load(workspace: string) {
    return this.readCurrent(await this.identity(workspace));
  }

  /** 仅在能证明尚未发布时返回 false；其它失败传播，绝不把未知写入当作可重试。 */
  private async publish(
    identity: MemoryFileIdentity,
    baseVersion: string | null,
    bytes: Buffer,
  ): Promise<boolean> {
    await mkdir(path.dirname(identity.filePath), { recursive: true });
    const temporaryPath = `${identity.filePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      const latest = await this.readCurrent(identity);
      if (latest.version !== baseVersion) {
        return false;
      }

      if (baseVersion === null) {
        try {
          await link(temporaryPath, identity.filePath);
        } catch (error: any) {
          if (error?.code === "EEXIST") {
            return false;
          }

          throw error;
        }
      } else {
        await rename(temporaryPath, identity.filePath);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }

    const written = await stat(identity.filePath);
    if (written.size !== bytes.byteLength) {
      throw new Error("项目记忆原子写入后的文件大小不一致。");
    }

    return true;
  }

  async update<T>(
    workspace: string,
    change: (
      document: MemoryDocument,
    ) =>
      | Promise<{ document: MemoryDocument; result: T }>
      | { document: MemoryDocument; result: T },
  ): Promise<StoredMemoryDocument & { result: T }> {
    const identity = await this.identity(workspace);

    return withFileLock(identity.filePath, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await this.readCurrent(identity);
        const changed = await change(current.document);
        const bytes = Buffer.from(
          serializeMemoryJsonl(changed.document),
          "utf8",
        );
        if (!(await this.publish(identity, current.version, bytes))) {
          continue;
        }

        return {
          document: changed.document,
          version: hash(bytes),
          projectKey: identity.projectKey,
          filePath: identity.filePath,
          result: changed.result,
        };
      }

      throw new Error(
        "项目记忆存储持续被外部修改，本次操作未提交；请稍后重新核对目标条目。",
      );
    });
  }
}
