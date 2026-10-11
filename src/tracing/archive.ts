/**
 * 将已结束任务的安全 Perfetto Trace Event JSON 持久化到平台数据目录，并按会话与任务隔离文件。
 * Engine 在尝试保存任务终态后调用 write（包括终态写库失败）；Engine 和 server/app.ts 通过 read 为历史任务提供下载，
 * 因此服务重启不会丢失已完成的性能时间线。输入是 TraceRecorder 已导出的安全 JSON 文本对象，
 * 输出是 data-directory/traces/<sessionId>/<taskId>.json，不保存模型或工具输出正文；脱敏工具参数仍属敏感本机数据。
 *
 * 1. archiveFile 统一构造以 sessionId 和 taskId 分层的路径，使同一会话的每个任务各有独立文件而不覆盖。
 * 2. write 先在目标目录写入随机临时文件，再 rename 为最终文件；写入故障记录受控警告并吞掉，不能妨碍任务终态、恢复或通知。
 * 3. read 返回持久化 JSON 文本供 HTTP 响应直接下载；taskIds 只列举目录中真实存在的任务文件，供统计框避免展示失效链接。
 *
 * 此模块只管理本机诊断文件，不参与 SQLite 历史、权限判断或任务重放。
 * 检查点写入独立目录并标 partial，成功终态后删除；显式保留期才清理过期普通 JSON，归档耗时写 DEBUG 日志。
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

export class TraceArchive {
  constructor(
    private dataDirectory: string,
    private log: Logger,
    private retentionDays = 0,
  ) {}

  /** 按会话隔离每个任务的文件，调用方只传递 Store 已保存的任务与会话 ID。 */
  private archiveFile(sessionId: string, taskId: string) {
    return path.join(this.dataDirectory, "traces", sessionId, taskId + ".json");
  }

  /** 以临时文件后原子替换保存完整 trace；故障不能让已执行工具或任务状态回滚。 */
  async write(sessionId: string, taskId: string, trace: unknown) {
    const saved = await this.writeFile(
      this.archiveFile(sessionId, taskId),
      sessionId,
      taskId,
      trace,
    );
    if (saved && this.retentionDays > 0) {
      await this.pruneExpired();
    }

    return saved;
  }

  private async writeFile(
    archiveFile: string,
    sessionId: string,
    taskId: string,
    trace: unknown,
  ) {
    const started = performance.now();
    const temporaryFile = path.join(
      path.dirname(archiveFile),
      `.${taskId}.${randomUUID()}.tmp`,
    );

    try {
      await mkdir(path.dirname(archiveFile), { recursive: true });
      await writeFile(temporaryFile, JSON.stringify(trace), "utf8");
      await rename(temporaryFile, archiveFile);
      this.log.debug({
        event: "tracing.archive_written",
        taskId,
        sessionId,
        durationMs: performance.now() - started,
      });

      return true;
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      this.log.warn({
        event: "tracing.archive_write_failed",
        module: "tracing",
        sessionId,
        taskId,
        err: error,
      });

      return false;
    }
  }

  async writeCheckpoint(sessionId: string, taskId: string, trace: any) {
    return this.writeFile(
      path.join(
        this.dataDirectory,
        "trace-checkpoints",
        sessionId,
        taskId + ".json",
      ),
      sessionId,
      taskId,
      {
        ...trace,
        metadata: {
          ...trace.metadata,
          partial: true,
          checkpointAt: new Date().toISOString(),
        },
      },
    );
  }

  /** 仅在显式配置保留期后清理普通 JSON；跳过链接、临时文件及仍在更新的检查点。 */
  private async pruneExpired() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    try {
      for (const directory of ["traces", "trace-checkpoints"]) {
        const root = path.join(this.dataDirectory, directory);
        const sessions = await readdir(root, { withFileTypes: true }).catch(
          () => [],
        );
        for (const session of sessions) {
          if (!session.isDirectory() || session.isSymbolicLink()) {
            continue;
          }

          const folder = path.join(root, session.name);
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) {
              continue;
            }

            const file = path.join(folder, entry.name);
            const stat = await lstat(file);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              await rm(file, { force: true });
            }
          }
        }
      }
    } catch (error) {
      this.log.warn({ event: "tracing.retention_failed", err: error });
    }
  }

  async readCheckpoint(sessionId: string, taskId: string) {
    try {
      return await readFile(
        path.join(
          this.dataDirectory,
          "trace-checkpoints",
          sessionId,
          taskId + ".json",
        ),
        "utf8",
      );
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        this.log.warn({
          event: "tracing.checkpoint_read_failed",
          err: error,
          taskId,
        });
      }

      return undefined;
    }
  }

  async removeCheckpoint(sessionId: string, taskId: string) {
    await rm(
      path.join(
        this.dataDirectory,
        "trace-checkpoints",
        sessionId,
        taskId + ".json",
      ),
      { force: true },
    );
  }

  /** 只返回数据目录中存在的 JSON 文件名，不能根据任务终态猜测 trace 已成功写入。 */
  async taskIds(sessionId: string) {
    try {
      const entries = await readdir(
        path.join(this.dataDirectory, "traces", sessionId),
        { withFileTypes: true },
      );

      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return [];
      }

      this.log.warn({
        event: "tracing.archive_list_failed",
        module: "tracing",
        sessionId,
        err: error,
      });

      return [];
    }
  }

  /** 返回已经落盘的 JSON 文本，避免 HTTP 导出时重复解析或重新序列化 trace。 */
  async read(sessionId: string, taskId: string) {
    try {
      return await readFile(this.archiveFile(sessionId, taskId), "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return undefined;
      }

      this.log.warn({
        event: "tracing.archive_read_failed",
        module: "tracing",
        sessionId,
        taskId,
        err: error,
      });

      return undefined;
    }
  }
}
