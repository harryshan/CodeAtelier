/**
 * 编排项目记忆的文件读取、全部有效摘要目录与模型结构化维护操作。
 * Engine 在新任务准备阶段调用 retrieve；ToolRunner/Runtime Broker 通过同一个 apply 入口执行维护或按 ID 读取。
 *
 * 1. retrieve 按工作区加载全部有效摘要，将文件错误安全降级为空 bundle，记录受控状态但绝不把记忆文件内容写入日志。
 * 2. readEntry 只加载当前项目，核对版本、启用状态与有效期后返回完整条目；不会写回 lastUsedAt 或改变任务目录。
 * 3. apply 校验单条 read 或原维护批次；维护仍在 FileStore 版本锁内运行 Mutator 并原子提交 JSONL；只返回操作摘要，不迁移其他格式。
 * 4. 两条路径均不在日志记录正文，复用工具生命周期 tracing；冲突不自动重试，未知写入不自动重放。
 */

import type { Logger } from "pino";
import { MemoryFileStore, MemoryVersionConflictError } from "./file-store.js";
import { applyMemoryMutation } from "./mutator.js";
import { retrieveMemoryBundle } from "./retriever.js";
import {
  memoryMutationSchema,
  memoryToolSchema,
  type MemoryScope,
} from "./types.js";

export interface MemoryRetrieval {
  available: boolean;
  bundle: ReturnType<typeof retrieveMemoryBundle> | null;
  errorCode?: string;
}

export class ProjectMemoryService {
  private readonly files: MemoryFileStore;

  constructor(
    directory: string,
    private readonly log: Logger,
  ) {
    this.files = new MemoryFileStore(directory);
  }

  async retrieve(workspace: string): Promise<MemoryRetrieval> {
    try {
      const stored = await this.files.load(workspace);
      const bundle = retrieveMemoryBundle(stored.document, stored.version);
      this.log.info({
        event: "memory.retrieval_completed",
        module: "memory",
        projectKey: stored.projectKey,
        entries: bundle.entries.length,
        available: true,
      });

      return { available: true, bundle };
    } catch (error) {
      this.log.warn({
        event: "memory.retrieval_failed",
        module: "memory",
        errorName: error instanceof Error ? error.name : typeof error,
      });

      return {
        available: false,
        bundle: null,
        errorCode: "memory_unavailable",
      };
    }
  }

  private async readEntry(
    scope: MemoryScope,
    version: string | null,
    id: string,
  ) {
    try {
      const stored = await this.files.load(scope.workspace);
      if (stored.version !== version) {
        throw new MemoryVersionConflictError();
      }

      const entry = stored.document.entries.find(
        (candidate) => candidate.id === id,
      );
      if (
        !stored.document.enabled ||
        !entry ||
        entry.status !== "active" ||
        (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now())
      ) {
        throw new Error("记忆条目不可读取：不存在、已停用或已失效。");
      }

      this.log.info({
        event: "memory.read_completed",
        module: "memory",
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        entries: 1,
      });

      return {
        projectKey: stored.projectKey,
        version: stored.version,
        operations: [{ action: "read" as const, id: entry.id, entry }],
      };
    } catch (error) {
      this.log.warn({
        event: "memory.read_failed",
        module: "memory",
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        code:
          error instanceof MemoryVersionConflictError
            ? "memory_version_conflict"
            : "memory_read_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  async apply(scope: MemoryScope, raw: unknown) {
    const request = memoryToolSchema.parse(raw);
    const operation = request.operations[0];
    if (operation.action === "read") {
      return this.readEntry(scope, request.expectedVersion, operation.id);
    }

    const mutation = memoryMutationSchema.parse(request);
    try {
      const stored = await this.files.update(
        scope.workspace,
        mutation.expectedVersion,
        (document) => applyMemoryMutation(document, mutation, scope),
      );
      this.log.info({
        event: "memory.apply_completed",
        module: "memory",
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        projectKey: stored.projectKey,
        operations: stored.result.length,
      });

      return {
        projectKey: stored.projectKey,
        version: stored.version,
        operations: stored.result,
      };
    } catch (error) {
      const code =
        error instanceof MemoryVersionConflictError
          ? "memory_version_conflict"
          : error instanceof Error && error.name === "MemoryValidationError"
            ? "memory_validation_failed"
            : "memory_apply_failed";
      this.log.warn({
        event:
          code === "memory_version_conflict"
            ? "memory.write_conflict"
            : "memory.apply_failed",
        module: "memory",
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        code,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }
}
