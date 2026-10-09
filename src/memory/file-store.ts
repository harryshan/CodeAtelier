/**
 * 将按工作区隔离的项目记忆保存为平台数据目录中的 JSONL 快照，兼容已有 Markdown 文件。
 * ProjectMemoryService 是唯一调用方；它提供结构化文档和期望版本，本模块完成真实路径哈希、读取、互斥和原子替换。
 *
 * 1. identity 解析真实工作区，再从其 SHA-256 推导不暴露路径的文件名。
 * 2. readStored/readCurrent 严格读取 JSONL，只有不存在时回读 Markdown；load 不写盘、不自动修复坏文件。
 * 3. update 按 JSONL 目标串行，复核来源版本、序列化并 flush 临时快照，提交前再次检查来源。
 * 4. 已有 JSONL 使用 rename 替换；首次建立使用 link 原子发布且不覆盖竞争目标，旧 Markdown 原件保持不动。
 *    迁移只随成功维护发生，返回安全迁移标记供 Service 审计；失败不自动重试，临时文件不参与读取。
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
import { parseMemoryDocument } from "./markdown.js";
import { parseMemoryJsonl, serializeMemoryJsonl } from "./jsonl.js";

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
  migratedFromMarkdown?: boolean;
}

interface MemoryFileIdentity {
  canonicalWorkspace: string;
  projectKey: string;
  filePath: string;
  legacyPath: string;
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
    const legacyPath = path.join(
      this.directory,
      "memories",
      `${projectKey}.md`,
    );

    return { canonicalWorkspace, projectKey, filePath, legacyPath };
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
      const document = filePath.endsWith(".md")
        ? parseMemoryDocument(text)
        : parseMemoryJsonl(text);
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
    if (current) {
      return current;
    }

    const legacy = await this.readStored(
      identity.projectKey,
      identity.canonicalWorkspace,
      identity.legacyPath,
    );

    return (
      legacy ?? {
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
      const current = await this.readCurrent(identity);
      if (current.version !== expectedVersion) {
        throw new MemoryVersionConflictError();
      }

      const changed = await change(current.document);
      const serialized = serializeMemoryJsonl(changed.document);
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

        const latest = await this.readCurrent(identity);
        if (
          latest.version !== current.version ||
          latest.filePath !== current.filePath
        ) {
          throw new MemoryVersionConflictError();
        }

        if (
          current.version === null ||
          current.filePath === identity.legacyPath
        ) {
          // 原子发布完整文件，不让迁移或首次创建覆盖竞争进程已建立的 JSONL。
          try {
            await link(temporaryPath, identity.filePath);
          } catch (error: any) {
            if (error?.code === "EEXIST") {
              throw new MemoryVersionConflictError();
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

      return {
        document: changed.document,
        version: hash(bytes),
        projectKey: identity.projectKey,
        filePath: identity.filePath,
        result: changed.result,
        migratedFromMarkdown: current.filePath === identity.legacyPath,
      };
    });
  }
}
