/**
 * LocalOverlayService 的平台挂载边界，当前生产实现使用已有 WinFsp v6 helper。
 * 1. LocalOverlayBackend/Mount 定义稳定目录命名、挂载身份、冻结收尾和停止；测试可替换真实文件系统。
 * 2. WinFspLocalBackend 使用独立命名空间，每次挂载创建新的 OverlayManager，拒绝非 Windows 静默降级。
 * 3. finish 在冻结租约中核对 v6 状态；可选明确选择先发布/确认，否则按 task ID 推进代次，再回收孤立内容并退出。
 * 4. recoverRefresh 仅在正常重挂载后的冻结租约内确认 complete 批次，不发布来源或执行任务；退出后返回私有代次。
 * 5. recoverAccess 使用根 ACL 专用挂载，允许保留 dirty 的卷撤销旧账户权限；不暴露 finish 或普通文件操作。
 * 不管理 Git、不安装驱动；调用方先排空任务并提供可信候选验证器，异常停止不能冒充成功收尾。
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
import {
  publishFrozen,
  type FrozenPublication,
  type PublicationState,
} from "./publication.js";
import { Publisher } from "./publication/publisher.js";
import type { Batch } from "./publication/session.js";

export interface LocalOverlayMount {
  identity(): Promise<string>;
  recoverRefresh?(
    batch: Batch,
    signal: AbortSignal,
  ): Promise<{ epoch: number }>;
  finish(
    taskId: string,
    publication?: FrozenPublication,
  ): Promise<{
    epoch: number;
    capturedPaths: number;
    publication?: PublicationState;
  }>;
  close(): Promise<void>;
}

export interface LocalOverlayBackend {
  workspace(id: string): string;
  idFor(workspace: string): string | undefined;
  recoverAccess?(
    id: string,
    source: string,
    control: string,
    signal: AbortSignal,
  ): Promise<Pick<LocalOverlayMount, "identity" | "close">>;
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

  async recoverAccess(
    id: string,
    source: string,
    control: string,
    signal: AbortSignal,
  ) {
    if (process.platform !== "win32") {
      throw new Error("ACL 恢复后端仅支持 Windows。");
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
        false,
        signal,
        { kind: "local-security" },
      );
    } catch (error) {
      await manager.close().catch(() => {});
      throw error;
    }

    return {
      identity: () => directoryIdentity(this.workspace(id)),
      close: () => manager.close(),
    };
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
      recoverRefresh: (batch: Batch, signal: AbortSignal) =>
        manager.withFrozen(
          id,
          async (_verify, acknowledge, current) => {
            await new Publisher(
              path.join(this.directory, "publications"),
              this.log,
            ).recoverRefresh(batch, control, acknowledge, { signal: current });
            const db = new DatabaseSync(path.join(control, "overlay.sqlite"), {
              readOnly: true,
            });
            try {
              const epoch = z
                .number()
                .int()
                .nonnegative()
                .parse(
                  db.prepare("SELECT epoch FROM local_state").get()?.epoch,
                );

              return { epoch };
            } finally {
              db.close();
            }
          },
          signal,
        ),
      finish: async (taskId: string, plan?: FrozenPublication) =>
        manager.withFrozen(
          id,
          async (verify, acknowledge, signal, collect, nextEpoch) => {
            const publication = plan
              ? await publishFrozen({
                  directory: path.join(this.directory, "publications"),
                  source,
                  control,
                  log: this.log,
                  plan,
                  signal,
                  verify,
                  acknowledge,
                })
              : undefined;
            if (publication) {
              await plan!.record(publication);
            }

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

            if (publication?.state !== "published") {
              await nextEpoch({ requestId: taskId, epoch, seal });
              epoch++;
            }

            await collect();

            return { epoch, capturedPaths, publication };
          },
        ),
    } satisfies LocalOverlayMount;
  }
}
