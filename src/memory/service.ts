/**
 * 编排项目记忆的文件读取、关键词检索与模型结构化维护操作。
 * Engine 在新任务准备阶段调用 retrieve；ToolRunner 在 `memory_apply` 中调用 apply，并向模型返回不含正文的结果摘要。
 *
 * 1. retrieve 将文件错误安全降级为空 bundle，记录受控状态但绝不把 Markdown 正文或查询写入日志。
 * 2. apply 绑定当前任务/工作区，先用 Zod 校验模型输入，再在 FileStore 版本锁内运行 Mutator 并原子提交。
 * 3. 返回的版本和操作 ID 供后续模型调用处理冲突；未知写入结果仍由恢复路径重新读取，不能自动重放。
 */

import type { Logger } from "pino";
import { MemoryFileStore, MemoryVersionConflictError } from "./file-store.js";
import { applyMemoryMutation } from "./mutator.js";
import { retrieveMemoryBundle } from "./retriever.js";
import { memoryMutationSchema, type MemoryScope } from "./types.js";

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

  async retrieve(workspace: string, query: string): Promise<MemoryRetrieval> {
    try {
      const stored = await this.files.load(workspace);
      const bundle = retrieveMemoryBundle(
        stored.document,
        stored.version,
        query,
      );
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

  async apply(scope: MemoryScope, raw: unknown) {
    const mutation = memoryMutationSchema.parse(raw);
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
