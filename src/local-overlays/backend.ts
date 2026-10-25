/**
 * LocalOverlayService 的平台挂载边界，当前生产实现使用已有 WinFsp v6 helper。
 * 1. LocalOverlayBackend/Mount 定义稳定目录命名、挂载身份、冻结收尾和停止；测试可替换真实文件系统。
 * 2. WinFspLocalBackend 使用独立命名空间，每次挂载创建新的 OverlayManager，拒绝非 Windows 静默降级。
 * 3. finish 在冻结租约中核对 v6 状态，按 task ID 推进代次并回收孤立内容；返回后 helper 已退出。
 * 不管理 Git、不发布来源、不安装驱动；调用方必须先排空任务，异常停止不能冒充成功收尾。
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";
import { z } from "zod";
import {
  OverlayManager,
  overlayNamespace,
  overlayWorkspace,
  overlayWorkspaceId,
} from "../worktrees/overlay.js";
import { directoryIdentity } from "../worktrees/git.js";

export interface LocalOverlayMount {
  identity(): Promise<string>;
  finish(taskId: string): Promise<{ epoch: number; capturedPaths: number }>;
  close(): Promise<void>;
}

export interface LocalOverlayBackend {
  workspace(id: string): string;
  idFor(workspace: string): string | undefined;
  open(
    id: string,
    source: string,
    control: string,
    create: boolean,
    signal: AbortSignal,
  ): Promise<LocalOverlayMount>;
}

export class WinFspLocalBackend implements LocalOverlayBackend {
  private readonly namespace: string;

  constructor(
    private readonly directory: string,
    private readonly log: Logger,
  ) {
    this.namespace = overlayNamespace(directory);
  }

  workspace(id: string) {
    return overlayWorkspace(this.namespace, id);
  }

  idFor(workspace: string) {
    return overlayWorkspaceId(this.namespace, workspace);
  }

  async open(
    id: string,
    source: string,
    control: string,
    create: boolean,
    signal: AbortSignal,
  ) {
    if (process.platform !== "win32") {
      throw new Error(
        "Local overlay 的当前文件系统后端仅支持 Windows；不会静默使用普通目录。",
      );
    }

    const manager = new OverlayManager(
      path.join(this.directory, "traces"),
      this.log,
    );
    try {
      await manager.start(
        id,
        source,
        control,
        this.workspace(id),
        create,
        signal,
        { kind: "local" },
      );
    } catch (error) {
      await manager.close().catch(() => {});
      throw error;
    }

    return {
      identity: () => directoryIdentity(this.workspace(id)),
      close: () => manager.close(),
      finish: async (taskId: string) =>
        manager.withFrozen(
          id,
          async (_verify, _acknowledge, _signal, collect, nextEpoch) => {
            const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
              readOnly: true,
            });
            let epoch: number;
            let seal: string;
            let capturedPaths: number;
            try {
              const meta = db.prepare("SELECT version,clean FROM meta").get();
              if (meta?.version !== 6 || meta.clean !== 0) {
                throw new Error("Local overlay 格式或冻结状态不匹配。");
              }

              const state = z
                .object({
                  epoch: z.number().int().min(0).max(999_999_999),
                  seal: z.uuid(),
                })
                .parse(db.prepare("SELECT epoch,seal FROM local_state").get());
              epoch = state.epoch;
              seal = state.seal;
              capturedPaths = z
                .number()
                .int()
                .nonnegative()
                .parse(
                  db.prepare("SELECT count(*) AS n FROM baselines").get()?.n,
                );
            } finally {
              db.close();
            }

            await nextEpoch({ requestId: taskId, epoch, seal });
            await collect();

            return { epoch: epoch + 1, capturedPaths };
          },
        ),
    } satisfies LocalOverlayMount;
  }
}
