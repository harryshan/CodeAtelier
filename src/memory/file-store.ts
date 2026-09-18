/**
 * 将按工作区隔离的项目记忆安全保存到平台数据目录的 Markdown 文件。
 * ProjectMemoryService 是唯一调用方；它提供结构化文档和期望版本，本模块完成真实路径哈希、读取、互斥和原子替换。
 *
 * 1. canonicalWorkspace 解析真实工作区，再从其 SHA-256 推导不暴露路径的文件名。
 * 2. load 读取并严格解析文件；不存在时返回未落盘的空文档，格式错误不会被悄悄修复。
 * 3. update 按文件路径串行，复核版本、写入已 flush 的同目录临时文件并替换目标；冲突或失败保留原版本。
 *
 * 本模块从不访问用户工作区内容，也不执行命令；写入范围固定为 Config 的平台数据目录 memories 子目录。
 */

import { createHash, randomUUID } from "node:crypto";
import {
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
import { parseMemoryDocument, serializeMemoryDocument } from "./markdown.js";

const locks = new Map<string, Promise<void>>();

export class MemoryVersionConflictError extends Error {
  constructor() {
    super("项目记忆文件已被其他操作更新，请重新读取后再决定。");
    this.name = "MemoryVersionConflictError";
  }
}

export interface StoredMemoryDocument {
  document: MemoryDocument;
  version: string | null;
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
    const filePath = path.join(this.directory, "memories", `${projectKey}.md`);

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
  ): Promise<StoredMemoryDocument> {
    try {
      const file = await readFile(filePath);
      if (file.byteLength > MAX_MEMORY_FILE_BYTES) {
        throw new Error("项目记忆文件超过 512 KiB 限制。");
      }

      const document = parseMemoryDocument(file.toString("utf8"));
      if (
        document.projectKey !== projectKey ||
        document.workspace !== workspace
      ) {
        throw new Error("项目记忆文件与当前真实工作区不匹配。");
      }

      return { document, version: hash(file), projectKey, filePath };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return {
          document: this.emptyDocument(projectKey, workspace),
          version: null,
          projectKey,
          filePath,
        };
      }

      throw error;
    }
  }

  async load(workspace: string) {
    const identity = await this.identity(workspace);

    return this.readStored(
      identity.projectKey,
      identity.canonicalWorkspace,
      identity.filePath,
    );
  }

  async update<T>(
    workspace: string,
    expectedVersion: string | null,
    change: (
      document: MemoryDocument,
    ) =>
      | Promise<{ document: MemoryDocument; result: T }>
      | { document: MemoryDocument; result: T },
  ): Promise<StoredMemoryDocument & { result: T }> {
    const identity = await this.identity(workspace);

    return withFileLock(identity.filePath, async () => {
      const current = await this.readStored(
        identity.projectKey,
        identity.canonicalWorkspace,
        identity.filePath,
      );
      if (current.version !== expectedVersion) {
        throw new MemoryVersionConflictError();
      }

      const changed = await change(current.document);
      const serialized = serializeMemoryDocument(changed.document);
      const bytes = Buffer.from(serialized, "utf8");
      if (bytes.byteLength > MAX_MEMORY_FILE_BYTES) {
        throw new Error("项目记忆文件超过 512 KiB 限制。");
      }

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

        await rename(temporaryPath, identity.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }

      const written = await stat(identity.filePath);
      if (written.size !== bytes.byteLength) {
        throw new Error("项目记忆原子写入后的文件大小不一致。");
      }

      return {
        document: changed.document,
        version: hash(bytes),
        projectKey: identity.projectKey,
        filePath: identity.filePath,
        result: changed.result,
      };
    });
  }
}
