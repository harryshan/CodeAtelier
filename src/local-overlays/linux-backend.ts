/**
 * LocalOverlayService 的 Linux 原生挂载与收尾后端，显式注入已核对 namespace 的控制器。
 * 1. workspace/idFor 使用显式视图根；控制根保留 B/upper，open 校验路径和 round，绑定 backing 身份。
 * 2. create 只初始化空 round，不遍历来源；续轮读取有界 B/依赖，pending 状态拒绝自动恢复。
 * 3. finish 在调用方证明 Runtime 排空后 seal，保存原始 B，再将明确选集交给生产 Publisher。
 * 4. complete 后确认当前私有/来源版本，持久刷新计划，正常卸载后按摘要移除覆盖；未选内容保留。
 * 5. 普通拒绝保存 rejected，未知结果保留 pending；close 幂等但不删除恢复证据或重放发布。
 * 6. 正常收尾在 round 保存、卸载后回收本轮 lower 缓存，未发布 B 与 upper 保留；失败不清 pending。
 * Service 负责任务锁/日志/tracing，控制 IPC 与 Publisher 也各有归档；此后端不建立 Sandbox 权限。
 * 尚未自动注册产品平台入口；不实现 WinFsp 检查/异常恢复接口，不把 mount inode 当跨轮身份。
 */
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { LocalOverlayBackend, LocalOverlayMount } from "./backend.js";
import type { LinuxOverlayController } from "./linux-controller.js";
import { discardLinuxCache } from "./linux-cache.js";
import type { FrozenPublication, PublicationState } from "./publication.js";
import {
  durableJson,
  sourceIdentity,
  type Source,
} from "./publication/files.js";
import { PublicationFailure, Publisher } from "./publication/publisher.js";
import { PublishError } from "./publication/merge.js";
import { posixBatch } from "./posix-batch.js";
import {
  acknowledgePosixRound,
  capturePosixRound,
  posixRoundInputs,
  validatePosixRound,
  type PosixRound,
} from "./posix-round.js";

export type LinuxMountController = Pick<
  LinuxOverlayController,
  "open" | "seal" | "close" | "release"
>;

async function readRound(file: string, source: Source) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 32 * 1024 * 1024
  ) {
    throw new PublishError("ROUND_STATE_INVALID");
  }

  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size !== info.size
    ) {
      throw new PublishError("ROUND_STATE_CHANGED");
    }

    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== info.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new PublishError("ROUND_STATE_CHANGED");
    }

    return validatePosixRound(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
      source,
    );
  } finally {
    await handle.close();
  }
}

export class LinuxLocalBackend implements LocalOverlayBackend {
  readonly format = "linux-overlay-v1" as const;

  constructor(
    private readonly root: string,
    private readonly controller: LinuxMountController,
    private readonly log: Logger,
    private readonly views?: string,
  ) {}

  workspace(id: string) {
    return this.views
      ? path.join(this.views, z.uuid().parse(id))
      : path.join(this.root, z.uuid().parse(id), "view");
  }

  idFor(workspace: string) {
    const relative = path
      .relative(this.views ?? this.root, workspace)
      .split(path.sep);
    const id = z.uuid().safeParse(relative[0]);

    return (this.views
      ? relative.length === 1
      : relative.length === 2 && relative[1] === "view") &&
      id.success &&
      this.workspace(id.data) === workspace
      ? id.data
      : undefined;
  }

  async open(
    id: string,
    sourceDirectory: string,
    control: string,
    create: boolean,
    signal: AbortSignal,
  ): Promise<LocalOverlayMount> {
    signal.throwIfAborted();
    if (control !== path.join(this.root, z.uuid().parse(id))) {
      throw new PublishError("CONTROL_REPLACED");
    }

    const pending = path.join(control, "round.pending.json");
    await lstat(pending).then(
      () => {
        throw new PublishError("ROUND_PENDING");
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      },
    );
    const source = await sourceIdentity(sourceDirectory);
    const file = path.join(control, "round.json");
    let state: PosixRound = create
      ? {
          version: 1,
          source,
          epoch: 0,
          baselines: [],
          reads: [],
        }
      : await readRound(file, source);
    const view = await this.controller.open(id, source.root, create);
    if (
      view.workspace !== this.workspace(id) ||
      view.upper !== path.join(control, "upper") ||
      path.dirname(view.control) !== control
    ) {
      throw new PublishError("CONTROL_REPLACED");
    }

    const identity = (await sourceIdentity(control)).identity;
    const cacheIdentity = (await sourceIdentity(view.control)).identity;
    if (create) {
      await durableJson(file, state);
    }

    let closed = false;
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= this.controller.close(id).then(() => {
        closed = true;
      }));
    let finishing:
      Promise<Awaited<ReturnType<LocalOverlayMount["finish"]>>> | undefined;
    const finish = async (taskId: string, plan?: FrozenPublication) => {
      z.uuid().parse(taskId);
      if (closed) {
        throw new PublishError("VIEW_CLOSED");
      }

      await durableJson(pending, { version: 1, taskId, phase: "capturing" });
      const sealId = await this.controller.seal(id);
      state = await capturePosixRound({
        source,
        control: view.control,
        sealId,
        upper: view.upper,
        previous: state,
      });
      await durableJson(file, state);
      let publication: PublicationState | undefined;
      if (plan) {
        const paths = [...plan.paths];
        let batch: Awaited<ReturnType<typeof posixBatch>> | undefined;
        try {
          plan.signal.throwIfAborted();
          batch = await posixBatch({
            source,
            control: view.control,
            workspace: view.workspace,
            sealId,
            selected: paths,
            ...posixRoundInputs(state, source, paths),
            signal: plan.signal,
          });
        } catch (error) {
          publication = {
            state: "rejected",
            paths,
            reason: plan.signal.aborted
              ? "CANCELLED"
              : error instanceof PublishError
                ? error.code
                : "EXPORT_REJECTED",
          };
        }

        if (batch) {
          await plan.record({ state: "publishing", paths, batchId: batch.id });
          const publications = path.join(this.root, "publications");
          try {
            const result = await new Publisher(publications, this.log).publish(
              batch,
              { signal: plan.signal, validate: plan.validate },
            );
            const acknowledged = await acknowledgePosixRound({
              state,
              batch,
              publications,
              workspace: view.workspace,
            });
            await durableJson(pending, {
              version: 1,
              taskId,
              batchId: batch.id,
              phase: "refreshing",
              ...acknowledged,
            });
            await close();
            await this.controller.release(id, acknowledged.remove);
            state = acknowledged.state;
            await durableJson(file, state);
            publication = {
              state: "published",
              paths,
              batchId: batch.id,
              files: result.files,
              cleanupPending: result.cleanupPending,
            };
          } catch (error) {
            if (
              !(error instanceof PublicationFailure) ||
              error.outcome !== "unapplied"
            ) {
              throw error;
            }

            publication = {
              state: "rejected",
              paths,
              batchId: batch.id,
              reason: plan.signal.aborted ? "CANCELLED" : error.reason,
            };
          }
        }

        await plan.record(publication!);
      }

      await close();
      await discardLinuxCache(control, view.control, cacheIdentity);
      await unlink(pending);

      return {
        epoch: state.epoch,
        capturedPaths: state.baselines.length,
        publication,
      };
    };

    return {
      identity: async () => {
        if ((await sourceIdentity(control)).identity !== identity) {
          throw new PublishError("CONTROL_REPLACED");
        }

        return `linux:${identity}`;
      },
      close,
      finish: (taskId, plan) => (finishing ??= finish(taskId, plan)),
    };
  }
}
